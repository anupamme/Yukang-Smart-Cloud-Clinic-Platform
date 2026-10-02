const test = require('node:test');
const assert = require('node:assert/strict');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');

async function registerOwner(server, suffix, serial) {
    const response = await server.request('/api/auth/register', {
        method: 'POST',
        body: {
            fullName: '陈医生',
            phone: '13800000111',
            idCard: makeValidIdCard(serial),
            clinicName: '知微门诊',
            orgMode: 'single',
            storeRole: 'single',
            username: `visit_update_${suffix}`,
            password: 'secret123',
            privacyAccepted: true,
        },
    });
    assert.equal(response.status, 201);
    return response.data;
}

async function createVisit(server, token, patient = {}) {
    const response = await server.request('/api/visits/complete', {
        method: 'POST',
        token,
        body: {
            patient: { name: '修改患者', gender: '女', age: 36, diagnosis: '风寒感冒', ...patient },
            prescriptions: [
                { name: '当归', qty: 2, price: 25, qtyUnit: '袋' },
            ],
        },
    });
    assert.equal(response.status, 200);
    return response.data;
}

test('v5 修改未收费未发药病历会原位同步且不重复新增', async () => {
    const server = await startV5Server('visit-update-pending');
    try {
        const auth = await registerOwner(server, 'pending', 501);
        const visit = await createVisit(server, auth.token);

        const updated = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '修改患者', gender: '女', age: 36, diagnosis: '风热感冒', advice: '清淡饮食' },
                prescriptions: [
                    { name: '当归', qty: 3, price: 20, qtyUnit: '袋' },
                ],
            },
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.data.updated, true);
        assert.equal(updated.data.billingAmount, 60);
        assert.equal(updated.data.pharmacyPushed, 1);
        assert.equal(updated.data.billId, visit.billId);

        const outpatients = await server.request('/api/outpatients', { token: auth.token });
        assert.equal(outpatients.data.length, 1);
        assert.equal(outpatients.data[0].diagnosis, '风热感冒');
        assert.equal(outpatients.data[0].prescriptions[0].qty, 3);
        assert.equal(outpatients.data[0].prescriptions[0].price, 20);

        const profiles = await server.request('/api/patients', { token: auth.token });
        assert.equal(profiles.data.length, 1);
        assert.equal(profiles.data[0].visitCount, 1);
        assert.equal(profiles.data[0].visits.length, 1);
        assert.equal(profiles.data[0].visits[0].diagnosis, '风热感冒');
        assert.equal(profiles.data[0].visits[0].prescriptions[0].qty, 3);

        const bills = await server.request('/api/billing', { token: auth.token });
        assert.equal(bills.data.bills.length, 1);
        assert.equal(bills.data.bills[0].id, visit.billId);
        assert.equal(bills.data.bills[0].amount, 60);
        assert.equal(bills.data.bills[0].status, 'pending');
        assert.equal(bills.data.bills[0].items[0].qty, 3);

        const pharmacy = await server.request('/api/pharmacy', { token: auth.token });
        assert.equal(pharmacy.data.length, 1);
        assert.equal(pharmacy.data[0].qty, 3);
        assert.equal(pharmacy.data[0].status, '待发药');
    } finally {
        await server.stop();
    }
});

test('v5 已收费病历禁止修改处方但允许修改诊断', async () => {
    const server = await startV5Server('visit-update-paid');
    try {
        const auth = await registerOwner(server, 'paid', 502);
        const visit = await createVisit(server, auth.token, { name: '已收费修改患者' });
        const paid = await server.request(`/api/billing/${visit.billId}/pay`, {
            method: 'POST',
            token: auth.token,
            body: { payMethod: '现金', receivedAmount: 50 },
        });
        assert.equal(paid.status, 200);

        const blocked = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '已收费修改患者', diagnosis: '新诊断' },
                prescriptions: [{ name: '当归', qty: 3, price: 20, qtyUnit: '袋' }],
            },
        });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.data.code, 'BILL_ALREADY_PAID');

        const allowed = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '已收费修改患者', diagnosis: '修正诊断', advice: '复诊提醒' },
                prescriptions: [{ name: '当归', qty: 2, price: 25, qtyUnit: '袋' }],
            },
        });
        assert.equal(allowed.status, 200);
        const bills = await server.request('/api/billing', { token: auth.token });
        assert.equal(bills.data.bills.length, 1);
        assert.equal(bills.data.bills[0].status, 'paid');
        assert.equal(bills.data.bills[0].actualAmount, 50);
        const outpatients = await server.request('/api/outpatients', { token: auth.token });
        assert.equal(outpatients.data[0].diagnosis, '修正诊断');
    } finally {
        await server.stop();
    }
});

test('v5 已发药病历禁止修改处方内容', async () => {
    const server = await startV5Server('visit-update-dispensed');
    try {
        const auth = await registerOwner(server, 'dispensed', 503);
        const visit = await createVisit(server, auth.token, { name: '已发药修改患者' });
        const pharmacy = await server.request('/api/pharmacy', { token: auth.token });
        const dispensed = await server.request(`/api/pharmacy/dispense/${pharmacy.data[0].id}`, {
            method: 'POST',
            token: auth.token,
        });
        assert.equal(dispensed.status, 200);

        const blocked = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '已发药修改患者', diagnosis: '仍可修改诊断' },
                prescriptions: [{ name: '当归', qty: 3, price: 20, qtyUnit: '袋' }],
            },
        });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.data.code, 'MEDICATION_ALREADY_DISPENSED');
    } finally {
        await server.stop();
    }
});

test('v5 修改姓名电话不会产生重复患者档案', async () => {
    const server = await startV5Server('visit-update-patient-key');
    try {
        const auth = await registerOwner(server, 'key', 504);
        const visit = await createVisit(server, auth.token, { name: '原名患者', phone: '13800000001' });
        const updated = await server.request(`/api/outpatients/${visit.data.id}/visit`, {
            method: 'PUT',
            token: auth.token,
            body: {
                patient: { name: '改名患者', phone: '13800000002', diagnosis: '风寒感冒' },
                prescriptions: [{ name: '当归', qty: 2, price: 25, qtyUnit: '袋' }],
            },
        });
        assert.equal(updated.status, 200);
        const profiles = await server.request('/api/patients', { token: auth.token });
        assert.equal(profiles.data.length, 1);
        assert.equal(profiles.data[0].name, '改名患者');
        assert.equal(profiles.data[0].phone, '13800000002');
        assert.equal(profiles.data[0].visitCount, 1);
        assert.equal(profiles.data[0].visits.length, 1);
    } finally {
        await server.stop();
    }
});
