const test = require('node:test');
const assert = require('node:assert/strict');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');

async function registerOwner(server, suffix = 'owner') {
    const response = await server.request('/api/auth/register', {
        method: 'POST',
        body: {
            fullName: '陈医生',
            phone: '13800000111',
            idCard: makeValidIdCard(401),
            clinicName: '知微门诊',
            orgMode: 'single',
            storeRole: 'single',
            username: `delete_${suffix}`,
            password: 'secret123',
            privacyAccepted: true,
        },
    });
    assert.equal(response.status, 201);
    return response.data;
}

async function createVisitWithPrescription(server, token, name, price = 25) {
    const response = await server.request('/api/visits/complete', {
        method: 'POST',
        token,
        body: {
            patient: { name, gender: '女', age: 30 },
            prescriptions: [
                { name: '当归', qty: 2, price, qtyUnit: '袋' },
            ],
        },
    });
    assert.equal(response.status, 200);
    return response.data;
}

test('v5 删除未收费、未发药门诊会同步清理待收费和待发药数据', async () => {
    const server = await startV5Server('outpatient-delete-pending');
    try {
        const auth = await registerOwner(server, 'pending');
        const visit = await createVisitWithPrescription(server, auth.token, '待删除患者');

        const outpatients = await server.request('/api/outpatients', { token: auth.token });
        assert.equal(outpatients.data.length, 1);
        assert.equal(outpatients.data[0].id, visit.data.id);

        const pendingBills = await server.request('/api/billing?status=pending', { token: auth.token });
        assert.equal(pendingBills.data.bills.length, 1);
        const pendingPharmacy = await server.request('/api/pharmacy', { token: auth.token });
        assert.equal(pendingPharmacy.data.length, 1);
        const patientProfiles = await server.request('/api/patients', { token: auth.token });
        assert.equal(patientProfiles.data.length, 1);
        assert.equal(patientProfiles.data[0].visits.length, 1);

        const deleted = await server.request(`/api/outpatients/${visit.data.id}`, {
            method: 'DELETE',
            token: auth.token,
        });
        assert.equal(deleted.status, 200);
        assert.equal(deleted.data.success, true);
        assert.equal(deleted.data.deletedOutpatient, 1);
        assert.equal(deleted.data.deletedBilling, 1);
        assert.equal(deleted.data.deletedPharmacy, 1);
        assert.equal(deleted.data.removedProfiles, 1);

        assert.equal((await server.request('/api/outpatients', { token: auth.token })).data.length, 0);
        assert.equal((await server.request('/api/billing', { token: auth.token })).data.bills.length, 0);
        assert.equal((await server.request('/api/pharmacy', { token: auth.token })).data.length, 0);
        assert.equal((await server.request('/api/patients', { token: auth.token })).data.length, 0);

        const deletedAgain = await server.request(`/api/outpatients/${visit.data.id}`, {
            method: 'DELETE',
            token: auth.token,
        });
        assert.equal(deletedAgain.status, 404);
        assert.equal(deletedAgain.data.code, 'VISIT_NOT_FOUND');
    } finally {
        await server.stop();
    }
});

test('v5 已收费门诊禁止删除以保护收费记录', async () => {
    const server = await startV5Server('outpatient-delete-paid');
    try {
        const auth = await registerOwner(server, 'paid');
        const visit = await createVisitWithPrescription(server, auth.token, '已收费患者');
        const paid = await server.request(`/api/billing/${visit.billId}/pay`, {
            method: 'POST',
            token: auth.token,
            body: { payMethod: '现金', receivedAmount: 50 },
        });
        assert.equal(paid.status, 200);

        const deleted = await server.request(`/api/outpatients/${visit.data.id}`, {
            method: 'DELETE',
            token: auth.token,
        });
        assert.equal(deleted.status, 409);
        assert.equal(deleted.data.code, 'BILL_ALREADY_PAID');
        assert.equal((await server.request('/api/outpatients', { token: auth.token })).data.length, 1);
        assert.equal((await server.request('/api/billing', { token: auth.token })).data.bills.length, 1);
    } finally {
        await server.stop();
    }
});

test('v5 已发药门诊禁止删除以保护发药记录', async () => {
    const server = await startV5Server('outpatient-delete-dispensed');
    try {
        const auth = await registerOwner(server, 'dispensed');
        const visit = await createVisitWithPrescription(server, auth.token, '已发药患者');
        const pharmacy = await server.request('/api/pharmacy', { token: auth.token });
        assert.equal(pharmacy.data.length, 1);

        const dispensed = await server.request(`/api/pharmacy/dispense/${pharmacy.data[0].id}`, {
            method: 'POST',
            token: auth.token,
        });
        assert.equal(dispensed.status, 200);

        const deleted = await server.request(`/api/outpatients/${visit.data.id}`, {
            method: 'DELETE',
            token: auth.token,
        });
        assert.equal(deleted.status, 409);
        assert.equal(deleted.data.code, 'MEDICATION_ALREADY_DISPENSED');
        assert.equal((await server.request('/api/outpatients', { token: auth.token })).data.length, 1);
    } finally {
        await server.stop();
    }
});
