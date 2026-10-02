const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { newId } = require('../utils/helpers');

async function migrateUnsafe(username) {
    const outpatients = await repo.readCollection(username, 'outpatients');
    const patients = await repo.readCollection(username, 'patients');
    const map = new Map((patients || []).map(p => [p.key, p]));
    const groups = {};
    for (const o of outpatients) {
        const name = String(o.name || '').trim();
        if (!name) continue;
        const phone = String(o.phone || '').trim();
        const key = (name + '|' + phone).toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(o);
    }

    let created = 0;
    let updated = 0;
    for (const key of Object.keys(groups)) {
        const list = groups[key].sort((a, b) => String(a.opDate || a.date).localeCompare(String(b.opDate || b.date)));
        const last = list[list.length - 1];
        const profile = {
            key,
            name: last.name,
            phone: last.phone || '',
            gender: last.gender || '',
            age: last.age || '',
            allergy: last.allergy || '',
            past: last.past || '',
            visitCount: list.length,
            lastVisit: last.opDate || last.date || '',
            visits: list.map(o => ({
                id: o.id,
                date: o.opDate || o.date,
                diagnosis: o.diagnosis || '',
                prescriptions: (o.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
            })),
            updatedAt: new Date().toISOString()
        };
        if (map.has(key)) {
            map.set(key, { ...map.get(key), ...profile });
            updated++;
        } else {
            map.set(key, { id: newId(), ...profile });
            created++;
        }
    }
    const out = [...map.values()];
    await repo.writeCollection(username, 'patients', out);
    return { success: true, total: out.length, created, updated };
}

async function upsertPatientUnsafe(username, outpatient) {
    const patients = await repo.readCollection(username, 'patients');
    const name = String(outpatient.name || '').trim();
    if (!name) return;
    const phone = String(outpatient.phone || '').trim();
    const key = (name + '|' + phone).toLowerCase();
    const idx = patients.findIndex(p => p.key === key);
    const visit = {
        id: outpatient.id,
        date: outpatient.opDate || outpatient.date || '',
        diagnosis: outpatient.diagnosis || '',
        prescriptions: (outpatient.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
    };
    const profile = {
        key,
        name,
        phone,
        gender: outpatient.gender || '',
        age: outpatient.age || '',
        allergy: outpatient.allergy || '',
        past: outpatient.past || '',
        visitCount: (idx >= 0 ? patients[idx].visitCount : 0) + 1,
        lastVisit: outpatient.opDate || outpatient.date || '',
        visits: idx >= 0 ? [...(patients[idx].visits || []), visit] : [visit],
        updatedAt: new Date().toISOString()
    };
    if (idx >= 0) patients[idx] = { ...patients[idx], ...profile };
    else patients.push({ id: newId(), ...profile });
    await repo.writeCollection(username, 'patients', patients);
}

function buildVisitRecord(outpatient) {
    return {
        id: outpatient.id,
        date: outpatient.opDate || outpatient.date || '',
        diagnosis: outpatient.diagnosis || '',
        prescriptions: (outpatient.prescriptions || []).map(d => ({ name: d.name, qty: d.qty }))
    };
}

function sortVisits(visits) {
    return [...visits].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

function applyLatestOutpatient(profile, outpatient) {
    if (!outpatient) return profile;
    return {
        ...profile,
        name: outpatient.name || profile.name || '',
        phone: outpatient.phone || '',
        gender: outpatient.gender || '',
        age: outpatient.age || '',
        allergy: outpatient.allergy || '',
        past: outpatient.past || '',
    };
}

async function updatePatientVisitUnsafe(username, previousOutpatient, updatedOutpatient) {
    const patients = await repo.readCollection(username, 'patients');
    const outpatients = await repo.readCollection(username, 'outpatients');
    const targetId = String(updatedOutpatient.id);
    const name = String(updatedOutpatient.name || '').trim();
    if (!name) throw new HttpError(400, '患者姓名不能为空', 'VALIDATION_ERROR');
    const phone = String(updatedOutpatient.phone || '').trim();
    const targetKey = (name + '|' + phone).toLowerCase();
    const updatedVisit = buildVisitRecord(updatedOutpatient);

    let targetProfile = null;
    const nextProfiles = [];
    const changedProfiles = [];

    for (const profile of patients) {
        const originalVisits = Array.isArray(profile.visits) ? profile.visits : [];
        const visits = originalVisits.filter(visit => String(visit.id || '') !== targetId);
        const wasSource = visits.length !== originalVisits.length;
        const isTarget = String(profile.key || '') === targetKey;

        if (isTarget) {
            if (!targetProfile) targetProfile = { ...profile, visits };
            else {
                const known = new Set((targetProfile.visits || []).map(visit => String(visit.id || '')));
                targetProfile.visits = [...(targetProfile.visits || []), ...visits.filter(visit => !known.has(String(visit.id || '')))];
            }
            continue;
        }
        if (wasSource && visits.length === 0) continue;
        if (wasSource) {
            const rebuilt = { ...profile, visits: sortVisits(visits), visitCount: visits.length, updatedAt: new Date().toISOString() };
            const latest = outpatients.find(item => String(item.id) === String(rebuilt.visits[rebuilt.visits.length - 1]?.id || ''));
            nextProfiles.push(applyLatestOutpatient(rebuilt, latest));
            changedProfiles.push(rebuilt.key);
            continue;
        }
        nextProfiles.push(profile);
    }

    if (!targetProfile) {
        targetProfile = { id: newId(), key: targetKey, visits: [] };
    }
    const visits = sortVisits([
        ...(targetProfile.visits || []).filter(visit => String(visit.id || '') !== targetId),
        updatedVisit,
    ]);
    const latestVisit = visits[visits.length - 1];
    const latestOutpatient = outpatients.find(item => String(item.id) === String(latestVisit?.id || '')) || updatedOutpatient;
    targetProfile = applyLatestOutpatient({
        ...targetProfile,
        key: targetKey,
        name,
        phone,
        visits,
        visitCount: visits.length,
        lastVisit: latestVisit?.date || updatedOutpatient.opDate || updatedOutpatient.date || '',
        updatedAt: new Date().toISOString(),
    }, latestOutpatient);
    nextProfiles.push(targetProfile);

    await repo.writeCollection(username, 'patients', nextProfiles);
    return {
        success: true,
        profileKey: targetKey,
        visitCount: visits.length,
        previousKey: String(previousOutpatient && previousOutpatient.key || '') || undefined,
        changedProfiles,
    };
}

async function migrate(username) {
    return repo.transaction(() => migrateUnsafe(username));
}

async function upsertPatient(username, outpatient) {
    return repo.transaction(() => upsertPatientUnsafe(username, outpatient));
}

async function updatePatientVisit(username, previousOutpatient, updatedOutpatient) {
    return repo.transaction(() => updatePatientVisitUnsafe(username, previousOutpatient, updatedOutpatient));
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

async function deleteOutpatientUnsafe(username, id) {
    const outpatients = await repo.readCollection(username, 'outpatients');
    const index = outpatients.findIndex(item => String(item.id) === String(id));
    if (index === -1) throw new HttpError(404, '门诊记录不存在或已被删除', 'VISIT_NOT_FOUND');
    const target = outpatients[index];

    const bills = await repo.readCollection(username, 'billing');
    const linkedBills = bills.filter(item => String(item.outpatientId || '') === String(id));
    if (linkedBills.some(item => item.status === 'paid')) {
        throw new HttpError(409, '该患者已完成收费，不能删除；请保留收费记录用于对账', 'BILL_ALREADY_PAID');
    }

    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const linkedPharmacy = pharmacy.filter(item => pharmacyItemBelongsToOutpatient(item, target));
    if (linkedPharmacy.some(item => item.status === '已发药')) {
        throw new HttpError(409, '该患者药品已经发药，不能删除；请先核对库存和发药记录', 'MEDICATION_ALREADY_DISPENSED');
    }

    outpatients.splice(index, 1);
    await repo.writeCollection(username, 'outpatients', outpatients);

    const remainingBills = bills.filter(item => String(item.outpatientId || '') !== String(id));
    if (remainingBills.length !== bills.length) await repo.writeCollection(username, 'billing', remainingBills);

    const linkedIds = new Set(linkedPharmacy.map(item => String(item.id)));
    const remainingPharmacy = pharmacy.filter(item => !linkedIds.has(String(item.id)));
    if (remainingPharmacy.length !== pharmacy.length) await repo.writeCollection(username, 'pharmacy', remainingPharmacy);

    const patients = await repo.readCollection(username, 'patients');
    const remainingPatients = [];
    let changedProfiles = 0;
    let removedProfiles = 0;
    for (const profile of patients) {
        const visits = (profile.visits || []).filter(item => String(item.id) !== String(id));
        if (!visits.length) {
            removedProfiles += 1;
            continue;
        }
        if (visits.length === (profile.visits || []).length) {
            remainingPatients.push(profile);
            continue;
        }
        const latest = visits[visits.length - 1];
        const latestOutpatient = outpatients.find(item => String(item.id) === String(latest.id));
        const updated = {
            ...profile,
            visits,
            visitCount: visits.length,
            lastVisit: latest.date || profile.lastVisit || '',
            updatedAt: new Date().toISOString()
        };
        if (latestOutpatient) {
            updated.name = latestOutpatient.name || updated.name;
            updated.gender = latestOutpatient.gender || '';
            updated.age = latestOutpatient.age || '';
            updated.phone = latestOutpatient.phone || '';
            updated.allergy = latestOutpatient.allergy || '';
            updated.past = latestOutpatient.past || '';
        }
        remainingPatients.push(updated);
        changedProfiles += 1;
    }
    if (changedProfiles || removedProfiles) {
        await repo.writeCollection(username, 'patients', remainingPatients);
    }

    return {
        success: true,
        deletedOutpatient: 1,
        deletedBilling: bills.length - remainingBills.length,
        deletedPharmacy: pharmacy.length - remainingPharmacy.length,
        updatedProfiles: changedProfiles,
        removedProfiles
    };
}

async function deleteOutpatient(username, id) {
    return repo.transaction(() => deleteOutpatientUnsafe(username, id));
}

module.exports = {
    migrate,
    upsertPatient,
    updatePatientVisit,
    updatePatientVisitUnsafe,
    deleteOutpatient
};
