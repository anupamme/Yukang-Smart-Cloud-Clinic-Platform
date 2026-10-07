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

test('药品分类只依据批准文号、药典精确条目或明确监管标识', () => {
    const cases = [
        [{ name: '示例药', approvalNo: '国药准字H12345678' }, '西药'],
        [{ name: '示例药', approvalNo: 'Z12345678' }, '中成药'],
        [{ name: '当归' }, '中药饮片'],
        [{ name: '甘草' }, '中药饮片'],
        [{ name: '胃苏颗粒' }, '中成药'],
        [{ name: '银翘解毒颗粒' }, '中成药'],
        [{ name: '中药配方颗粒测试' }, '中药配方颗粒'],
        [{ name: '示例保健食品', approvalNo: '国食健注G20230001' }, '保健食品'],
        [{ name: '示例制剂', approvalNo: '药制字Z20260001' }, '自制成品'],
    ];

    for (const [item, expected] of cases) {
        assert.equal(inventoryService.classifyInventoryDrug(item).category, expected, item.name);
    }
});

test('没有客观证据时不能按名称关键词猜测药品分类', () => {
    for (const name of ['神秘颗粒', '无菌敷贴', '弹性创口贴', '75%消毒酒精（喷雾型）']) {
        assert.equal(inventoryService.classifyInventoryDrug({ name }).category, '未归类', name);
    }
});

test('历史分类迁移修正法定名称并保留合法非药品分类', () => {
    const inventory = [
        { name: '当归', category: '中药饮片' },
        { name: '旧饮片名称', category: '中药饮品' },
        { name: '旧颗粒名称', category: '中药颗粒' },
        { name: '无菌敷贴', category: '医疗器械' },
        { name: '一次性耗材', category: '医用耗材' },
        { name: '消毒商品', category: '其他商品' },
        { name: '无证据商品', category: '随便分类' },
        { name: '化学药示例', category: '', approvalNo: 'H12345678' },
    ];
    const records = [
        { drugName: '旧饮片名称', category: '中药饮品' },
        { drugName: '无证据商品', category: '随便分类' },
        { drugName: '化学药示例', category: '' },
    ];

    const result = inventoryService.migrateLegacyInventoryData(inventory, records);

    assert.equal(inventory[0].category, '中药饮片');
    assert.equal(inventory[1].category, '中药饮片');
    assert.equal(inventory[2].category, '中药配方颗粒');
    assert.equal(inventory[3].category, '医疗器械');
    assert.equal(inventory[4].category, '医用耗材');
    assert.equal(inventory[5].category, '其他商品');
    assert.equal(inventory[6].category, '未归类');
    assert.equal(inventory[7].category, '西药');
    assert.equal(records[0].category, '中药饮片');
    assert.equal(records[1].category, '未归类');
    assert.equal(records[2].category, '西药');
    assert.equal(result.unclassifiedInventory, 1);
    assert.equal(result.unclassifiedRecords, 1);
});

test('v5 新入库可用客观证据归类并同步库存与入库记录', async () => {
    const server = await startV5Server('inventory-category-stock-in');
    try {
        const auth = await registerOwner(server, 'stock', 601);
        const stocked = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '当归', qty: 5, unit: '袋', cost: 10, price: 20 },
        });
        assert.equal(stocked.status, 201);
        assert.equal(stocked.data.category, '中药饮片');

        const inventory = await server.request('/api/drugInventory', { token: auth.token });
        const records = await server.request('/api/drugInRecords', { token: auth.token });
        assert.equal(inventory.data.length, 1);
        assert.equal(inventory.data[0].category, '中药饮片');
        assert.equal(records.data.length, 1);
        assert.equal(records.data[0].category, '中药饮片');
    } finally {
        await server.stop();
    }
});

test('v5 没有客观证据的新药品不能由后端按名称猜测，但可人工确认', async () => {
    const server = await startV5Server('inventory-category-unknown');
    try {
        const auth = await registerOwner(server, 'unknown', 602);
        const missing = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '神秘颗粒', qty: 2, unit: '盒' },
        });
        assert.equal(missing.status, 400);
        assert.equal(missing.data.code, 'CATEGORY_REQUIRED');

        const manual = await server.request('/api/drug-inventory/stock-in', {
            method: 'POST',
            token: auth.token,
            body: { drugName: '神秘颗粒', qty: 2, unit: '盒', category: '中成药' },
        });
        assert.equal(manual.status, 201);
        const inventory = await server.request('/api/drugInventory', { token: auth.token });
        assert.equal(inventory.data[0].category, '中成药');
    } finally {
        await server.stop();
    }
});

test('v5 Excel 导入同步分类到库存和入库记录', async () => {
    const server = await startV5Server('inventory-category-batch');
    try {
        const auth = await registerOwner(server, 'batch', 603);
        const imported = await server.request('/api/drug-inventory/batch-import', {
            method: 'POST',
            token: auth.token,
            body: {
                items: [
                    { name: '胃苏颗粒', stock: 10, unit: '盒', costPrice: 8, price: 15 },
                    { name: '无菌敷贴', stock: 5, unit: '片', category: '医用耗材' },
                ],
            },
        });
        assert.equal(imported.status, 200);
        assert.equal(imported.data.added, 2);

        const inventory = await server.request('/api/drugInventory', { token: auth.token });
        const records = await server.request('/api/drugInRecords', { token: auth.token });
        assert.equal(inventory.data.find(item => item.name === '胃苏颗粒').category, '中成药');
        assert.equal(inventory.data.find(item => item.name === '无菌敷贴').category, '医用耗材');
        assert.equal(records.data.find(item => item.drugName === '胃苏颗粒').category, '中成药');
        assert.equal(records.data.find(item => item.drugName === '无菌敷贴').category, '医用耗材');
    } finally {
        await server.stop();
    }
});
