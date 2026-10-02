const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const patientService = require('./patientService');
const billingService = require('./billingService');
const { newId, toNum, todayKey } = require('../utils/helpers');

function normalizePrescriptionItems(prescriptions) {
    const cleanRx = [];
    for (const d of prescriptions || []) {
        const name = String(d.name || '').trim();
        const qty = toNum(d.qty);
        const price = Math.max(0, toNum(d.price));
        if (!name || qty <= 0) continue;
        cleanRx.push({
            name,
            spec: String(d.spec || '').trim(),
            dosage: d.dosage === undefined ? '' : String(d.dosage),
            dosageUnit: String(d.dosageUnit || '').trim(),
            usage: String(d.usage || '').trim(),
            frequency: String(d.frequency || '').trim(),
            qty,
            qtyUnit: String(d.qtyUnit || '').trim(),
            prescriptionType: String(d.prescriptionType || '').trim(),
            price,
            subtotal: +(qty * price).toFixed(2)
        });
    }
    return cleanRx;
}

function prescriptionSignature(items) {
    return JSON.stringify((items || []).map(item => ({
        name: String(item.name || '').trim(),
        spec: String(item.spec || '').trim(),
        dosage: String(item.dosage || '').trim(),
        dosageUnit: String(item.dosageUnit || '').trim(),
        usage: String(item.usage || '').trim(),
        frequency: String(item.frequency || '').trim(),
        qty: Number(item.qty || 0),
        qtyUnit: String(item.qtyUnit || '').trim(),
        prescriptionType: String(item.prescriptionType || '').trim(),
        price: Number(item.price || 0),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'zh-CN')));
}

async function assertInventoryAvailable(username, cleanRx) {
    if (!cleanRx.length) return;
    const inventory = await repo.readCollection(username, 'drugInventory');
    for (const d of cleanRx) {
        const inv = inventory.find(i => i.name === d.name);
        if (inv && toNum(inv.stock || inv.quantity) < d.qty) {
            throw new HttpError(400, `【库存不足】药品${d.name}当前库存仅 ${toNum(inv.stock || inv.quantity)} ${inv.unit || '盒'}，处方需要 ${d.qty}，请先入库或调整处方`, 'INSUFFICIENT_STOCK');
        }
    }
}

function pharmacyItemBelongsToOutpatient(item, outpatient) {
    if (String(item.outpatientId || '') === String(outpatient.id)) return true;
    if (item.outpatientId) return false;
    if (String(item.patient || '') !== String(outpatient.name || '')) return false;
    return (outpatient.prescriptions || []).some(rx =>
        String(rx.name || '') === String(item.drug || '') &&
        Number(rx.qty || 0) === Number(item.qty || 0)
    );
}

function buildVisitFields(patient, cleanRx) {
    return {
        chief: String(patient.chief || '').trim(),
        history: String(patient.history || '').trim(),
        past: String(patient.past || '').trim(),
        allergy: String(patient.allergy || '').trim(),
        exam: String(patient.exam || '').trim(),
        tcm: String(patient.tcm || '').trim(),
        diagnosis: String(patient.diagnosis || '').trim(),
        syndrome: String(patient.syndrome || '').trim(),
        advice: String(patient.advice || '').trim(),
        visitType: patient.visitType || '初诊',
        feeType: '自费',
        clinicData: patient.clinicData && typeof patient.clinicData === 'object' ? patient.clinicData : {},
        prescriptions: cleanRx
    };
}

async function completeVisitUnsafe(username, body) {
    const data = body || {};
    const outpatientId = data.outpatientId;
    const patient = data.patient || {};
    const cleanRx = normalizePrescriptionItems(data.prescriptions);
    const drugTotal = cleanRx.reduce((sum, item) => sum + item.subtotal, 0);
    const outpatients = await repo.readCollection(username, 'outpatients');

    let name = String(patient.name || '').trim();
    if (!name && outpatientId) {
        const existing = outpatients.find(item => String(item.id) === String(outpatientId));
        if (existing) name = String(existing.name || '').trim();
    }
    if (!name) throw new HttpError(400, '患者姓名不能为空', 'VALIDATION_ERROR');
    await assertInventoryAvailable(username, cleanRx);

    if (outpatientId) {
        const existing = outpatients.find(item => String(item.id) === String(outpatientId));
        if (existing && existing.status === '已就诊') {
            throw new HttpError(403, '已保存的接诊记录请使用修改病历功能', 'VISIT_IMMUTABLE');
        }
    }

    const todayStr = todayKey();
    const nowISO = new Date().toISOString();
    const baseFields = buildVisitFields(patient, cleanRx);
    let savedOutpatient = null;

    if (outpatientId) {
        const idx = outpatients.findIndex(item => String(item.id) === String(outpatientId));
        if (idx === -1) throw new HttpError(404, '门诊记录不存在，请刷新后重试', 'VISIT_NOT_FOUND');
        const original = outpatients[idx];
        savedOutpatient = {
            ...original,
            ...baseFields,
            name: original.name || name,
            gender: patient.gender !== undefined ? patient.gender : (original.gender || ''),
            age: patient.age !== undefined && patient.age !== '' ? patient.age : (original.age || ''),
            phone: patient.phone !== undefined ? patient.phone : (original.phone || ''),
            status: '已就诊',
            updatedAt: nowISO
        };
        outpatients[idx] = savedOutpatient;
    } else {
        savedOutpatient = {
            id: newId(),
            name,
            gender: patient.gender || '',
            age: patient.age || '',
            phone: patient.phone || '',
            ...baseFields,
            status: '已就诊',
            date: todayStr,
            opDate: todayStr,
            source: 'direct',
            createdAt: nowISO,
            updatedAt: nowISO
        };
        outpatients.push(savedOutpatient);
    }
    await repo.writeCollection(username, 'outpatients', outpatients);
    await patientService.upsertPatient(username, savedOutpatient);

    let pendingBill = null;
    if (drugTotal > 0) {
        pendingBill = await billingService.createPendingBill(username, {
            outpatientId: savedOutpatient.id,
            patientName: savedOutpatient.name,
            amount: +drugTotal.toFixed(2),
            items: cleanRx,
        });
    }

    let pharmacyPushed = 0;
    if (cleanRx.length > 0) {
        const settings = await repo.readCollection(username, 'settings');
        if (settings.autoPharmacy !== false) {
            const pharmacy = await repo.readCollection(username, 'pharmacy');
            for (const d of cleanRx) {
                pharmacy.push({
                    id: newId(),
                    outpatientId: savedOutpatient.id,
                    patient: savedOutpatient.name,
                    drug: d.name,
                    qty: d.qty,
                    price: d.price,
                    status: '待发药',
                    date: new Date().toLocaleString(),
                    source: '门诊处方'
                });
            }
            await repo.writeCollection(username, 'pharmacy', pharmacy);
            pharmacyPushed = cleanRx.length;
        }
    }

    return {
        data: savedOutpatient,
        pharmacyPushed,
        billingAmount: pendingBill ? pendingBill.amount : 0,
        billId: pendingBill ? pendingBill.id : null,
        billNo: pendingBill ? pendingBill.billNo : null,
        billingStatus: pendingBill ? pendingBill.status : null,
    };
}

async function updateSavedVisitUnsafe(username, id, body) {
    const data = body || {};
    const patient = data.patient || {};
    const cleanRx = normalizePrescriptionItems(data.prescriptions);
    const outpatients = await repo.readCollection(username, 'outpatients');
    const index = outpatients.findIndex(item => String(item.id) === String(id));
    if (index === -1) throw new HttpError(404, '门诊记录不存在，请刷新后重试', 'VISIT_NOT_FOUND');

    const previous = {
        ...outpatients[index],
        prescriptions: (outpatients[index].prescriptions || []).map(item => ({ ...item }))
    };
    if (previous.status !== '已就诊') {
        throw new HttpError(409, '该门诊尚未保存完成，请使用保存接诊', 'VISIT_NOT_SAVED');
    }

    const name = String(patient.name || previous.name || '').trim();
    if (!name) throw new HttpError(400, '患者姓名不能为空', 'VALIDATION_ERROR');
    const previousRx = normalizePrescriptionItems(previous.prescriptions);
    const rxChanged = prescriptionSignature(previousRx) !== prescriptionSignature(cleanRx);
    const drugTotal = cleanRx.reduce((sum, item) => sum + item.subtotal, 0);

    const bills = await repo.readCollection(username, 'billing');
    const linkedBillIndexes = bills
        .map((item, idx) => ({ item, idx }))
        .filter(entry => String(entry.item.outpatientId || '') === String(id));
    const linkedBills = linkedBillIndexes.map(entry => entry.item);
    const paidBill = linkedBills.find(item => item.status === 'paid');
    if (rxChanged && paidBill) {
        throw new HttpError(409, '该病历已收费，不能修改处方、数量或金额；如需更正请先处理收费记录', 'BILL_ALREADY_PAID');
    }

    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const linkedPharmacy = pharmacy.filter(item => pharmacyItemBelongsToOutpatient(item, previous));
    const dispensedItems = linkedPharmacy.filter(item => item.status === '已发药');
    if (rxChanged && dispensedItems.length) {
        throw new HttpError(409, '该病历药品已经发药，不能修改处方内容；请先核对发药和库存记录', 'MEDICATION_ALREADY_DISPENSED');
    }
    if (rxChanged) await assertInventoryAvailable(username, cleanRx);

    const nowISO = new Date().toISOString();
    const patientFields = {
        ...buildVisitFields(patient, cleanRx),
        name,
        gender: patient.gender !== undefined ? patient.gender : (previous.gender || ''),
        age: patient.age !== undefined && patient.age !== '' ? patient.age : (previous.age || ''),
        phone: patient.phone !== undefined ? patient.phone : (previous.phone || ''),
        feeType: '自费',
        status: '已就诊',
        updatedAt: nowISO,
        clinicData: patient.clinicData && typeof patient.clinicData === 'object' ? patient.clinicData : (previous.clinicData || {}),
    };
    const savedOutpatient = { ...previous, ...patientFields };
    outpatients[index] = savedOutpatient;
    await repo.writeCollection(username, 'outpatients', outpatients);
    await patientService.updatePatientVisitUnsafe(username, previous, savedOutpatient);

    let pendingBill = null;
    const pendingEntries = linkedBillIndexes.filter(entry => entry.item.status === 'pending');
    const removeBillIndexes = new Set();
    let billsChanged = false;
    for (let i = 1; i < pendingEntries.length; i += 1) removeBillIndexes.add(pendingEntries[i].idx);

    if (pendingEntries.length) {
        const firstIndex = pendingEntries[0].idx;
        if (drugTotal > 0) {
            pendingBill = {
                ...bills[firstIndex],
                patientName: savedOutpatient.name,
                amount: +drugTotal.toFixed(2),
                items: cleanRx,
                updatedAt: nowISO,
            };
            bills[firstIndex] = pendingBill;
        } else {
            removeBillIndexes.add(firstIndex);
        }
        billsChanged = true;
    }

    for (const entry of linkedBillIndexes) {
        if (entry.item.patientName !== savedOutpatient.name) {
            bills[entry.idx] = { ...bills[entry.idx], patientName: savedOutpatient.name, updatedAt: nowISO };
            billsChanged = true;
        }
    }
    if (removeBillIndexes.size) {
        const keptBills = bills.filter((_, idx) => !removeBillIndexes.has(idx));
        bills.splice(0, bills.length, ...keptBills);
        billsChanged = true;
    }
    if (billsChanged) await repo.writeCollection(username, 'billing', bills);

    if (!pendingEntries.length && drugTotal > 0 && !paidBill) {
        pendingBill = await billingService.createPendingBill(username, {
            outpatientId: savedOutpatient.id,
            patientName: savedOutpatient.name,
            amount: +drugTotal.toFixed(2),
            items: cleanRx,
        });
    }

    let pharmacyPushed = 0;
    if (!dispensedItems.length) {
        const linkedIds = new Set(linkedPharmacy.map(item => String(item.id)));
        const keptPharmacy = pharmacy.filter(item => !linkedIds.has(String(item.id)));
        const settings = await repo.readCollection(username, 'settings');
        if (settings.autoPharmacy !== false && cleanRx.length > 0) {
            const reusableIds = linkedPharmacy
                .filter(item => item.status === '待发药')
                .map(item => item.id);
            cleanRx.forEach((drug, idx) => {
                keptPharmacy.push({
                    id: reusableIds[idx] || newId(),
                    outpatientId: savedOutpatient.id,
                    patient: savedOutpatient.name,
                    drug: drug.name,
                    qty: drug.qty,
                    price: drug.price,
                    status: '待发药',
                    date: new Date().toLocaleString(),
                    source: '门诊处方'
                });
            });
            pharmacyPushed = cleanRx.length;
        }
        if (linkedPharmacy.length || pharmacyPushed) {
            await repo.writeCollection(username, 'pharmacy', keptPharmacy);
        }
    }

    return {
        data: savedOutpatient,
        updated: true,
        pharmacyPushed,
        billingAmount: drugTotal,
        billId: pendingBill ? pendingBill.id : (paidBill ? paidBill.id : null),
        billNo: pendingBill ? pendingBill.billNo : (paidBill ? paidBill.billNo : null),
        billingStatus: pendingBill ? pendingBill.status : (paidBill ? paidBill.status : null),
    };
}

async function completeVisit(username, body) {
    return repo.transaction(() => completeVisitUnsafe(username, body));
}

async function updateSavedVisit(username, id, body) {
    return repo.transaction(() => updateSavedVisitUnsafe(username, id, body));
}

module.exports = {
    completeVisit,
    updateSavedVisit
};
