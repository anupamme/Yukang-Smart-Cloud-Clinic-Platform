const test = require('node:test');
const assert = require('node:assert/strict');
const { startV5Server, makeValidIdCard } = require('./v5ServerHarness');
const inventoryService = require('../src/services/inventoryService');

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
            username: `inventory_category_${suffix}`,
            password: 'secret123',
            privacyAccepted: true,
        },
    });
    assert.equal(response.status, 201);
    return response.data;
}

test('v5 新入库必须选择分类且中药饮片自动规范为中药饮品', async () => {
    const server = await startV5Server('inventory-category-stock-in');
    try {
        const auth = await registerOwner(server, 'stock', 601);
        const missing = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '当归', qty: 5, unit: '袋', cost: 10, price: 20 },
        });
        assert.equal(missing.status, 400);
        assert.equal(missing.data.code, 'VALIDATION_ERROR');

        const stocked = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '当归', qty: 5, unit: '袋', cost: 10, price: 20, category: '中药饮片' },
        });
        assert.equal(stocked.status, 201);

        const inventory = await server.request('/api/drugInventory', { token: auth.token });
        assert.equal(inventory.data.length, 1);
        assert.equal(inventory.data[0].category, '中药饮品');

        const records = await server.request('/api/drugInRecords', { token: auth.token });
        assert.equal(records.data.length, 1);
        assert.equal(records.data[0].category, '中药饮品');
    } finally {
        await server.stop();
    }
});

test('v5 历史未归类药品再次入库时必须补选分类', async () => {
    const server = await startV5Server('inventory-category-existing');
    try {
        const auth = await registerOwner(server, 'existing', 602);
        const legacy = await server.request('/api/drugInventory', {
            method: 'POST',
            token: auth.token,
            body: { name: '无菌敷贴', stock: 1, unit: '片', category: '' },
        });
        assert.equal(legacy.status, 201);

        const missing = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '无菌敷贴', qty: 2, unit: '片' },
        });
        assert.equal(missing.status, 400);
        assert.equal(missing.data.code, 'VALIDATION_ERROR');

        const stocked = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '无菌敷贴', qty: 2, unit: '片', category: '自制成品' },
        });
        assert.equal(stocked.status, 201);
        const inventory = await server.request('/api/drugInventory', { token: auth.token });
        assert.equal(inventory.data[0].category, '自制成品');
        assert.equal(inventory.data[0].stock, 3);
    } finally {
        await server.stop();
    }
});

test('v5 Excel 批量导入新药要求分类并同步写入库存和入库记录', async () => {
    const server = await startV5Server('inventory-category-batch');
    try {
        const auth = await registerOwner(server, 'batch', 603);
        const missing = await server.request('/api/drug-inventory/batch-import', {
            method: 'POST',
            token: auth.token,
            body: { items: [{ name: '阿莫西林胶囊', stock: 10, unit: '盒' }] },
        });
        assert.equal(missing.status, 400);
        assert.equal(missing.data.code, 'VALIDATION_ERROR');

        const imported = await server.request('/api/drug-inventory/batch-import', {
            method: 'POST',
            token: auth.token,
            body: { items: [{ name: '阿莫西林胶囊', stock: 10, unit: '盒', category: '西药', costPrice: 8, price: 15 }] },
        });
        assert.equal(imported.status, 200);
        const inventory = await server.request('/api/drugInventory', { token: auth.token });
        const records = await server.request('/api/drugInRecords', { token: auth.token });
        assert.equal(inventory.data[0].category, '西药');
        assert.equal(records.data[0].category, '西药');
    } finally {
        await server.stop();
    }
});

test('v5 历史分类迁移会把中药饮片改为中药饮品', () => {
    const inventory = [{ name: '当归', category: '中药饮片' }];
    const records = [{ drugName: '当归', category: '中药饮片' }, { drugName: '未知药', category: '中药饮片' }];
    const result = inventoryService.migrateLegacyInventoryData(inventory, records);
    assert.equal(result.inventoryUpdated, 1);
    assert.equal(result.recordsUpdated, 2);
    assert.equal(inventory[0].category, '中药饮品');
    assert.equal(records[0].category, '中药饮品');
    assert.equal(records[1].category, '中药饮品');
});
