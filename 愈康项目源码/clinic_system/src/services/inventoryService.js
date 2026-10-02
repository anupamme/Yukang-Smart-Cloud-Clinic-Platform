const HttpError = require('../errors/HttpError');
const repo = require('../repository/sqliteRepository');
const { newId, toNum, todayKey } = require('../utils/helpers');

const INVENTORY_CATEGORIES = ['中药饮品', '中成药', '西药', '中药颗粒', '自制成品', '保健食品'];
const LEGACY_CATEGORY_MAP = { '中药饮片': '中药饮品' };

function normalizeInventoryCategory(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return LEGACY_CATEGORY_MAP[raw] || raw;
}

function validateInventoryCategory(value, required) {
    const category = normalizeInventoryCategory(value);
    if (!category && required) {
        throw new HttpError(400, '请选择药品类型，新入库药品必须归类', 'VALIDATION_ERROR');
    }
    if (category && !INVENTORY_CATEGORIES.includes(category)) {
        throw new HttpError(400, `药品类型无效：${category}`, 'VALIDATION_ERROR');
    }
    return category;
}

function migrateLegacyInventoryData(inventory = [], inRecords = []) {
    let inventoryUpdated = 0;
    let recordsUpdated = 0;
    const categoryByName = new Map();

    for (const drug of inventory) {
        const oldCategory = String(drug.category || '').trim();
        const category = normalizeInventoryCategory(oldCategory);
        if (category !== oldCategory) {
            drug.category = category;
            inventoryUpdated += 1;
        }
        if (category) categoryByName.set(String(drug.name || '').trim().toLowerCase(), category);
    }

    for (const record of inRecords) {
        const oldCategory = String(record.category || '').trim();
        const inventoryCategory = categoryByName.get(String(record.drugName || '').trim().toLowerCase()) || '';
        const category = inventoryCategory || normalizeInventoryCategory(oldCategory);
        if (category && category !== oldCategory) {
            record.category = category;
            recordsUpdated += 1;
        }
    }

    return { inventoryUpdated, recordsUpdated };
}

async function checkInventoryUnsafe(username, operator, body) {
    const items = Array.isArray(body && body.items) ? body.items : [];
    if (!items.length) throw new HttpError(400, '盘点数据不能为空', 'VALIDATION_ERROR');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const checks = await repo.readCollection(username, 'inventoryChecks');
    const details = [];
    let changed = 0;

    for (const it of items) {
        const actual = Number(it.actual);
        if (!Number.isFinite(actual) || actual < 0) continue;
        const drug = it.id
            ? inventory.find(d => String(d.id) === String(it.id))
            : inventory.find(d => d.name === it.name);
        if (!drug) continue;
        const oldStock = toNum(drug.stock || drug.quantity);
        if (oldStock !== actual) {
            drug.stock = actual;
            drug.updatedAt = new Date().toISOString();
            changed++;
        }
        details.push({ name: drug.name, oldStock, newStock: actual, diff: +(actual - oldStock).toFixed(2) });
    }

    await repo.writeCollection(username, 'drugInventory', inventory);
    checks.push({ id: newId(), date: new Date().toLocaleString(), operator, items: details });
    await repo.writeCollection(username, 'inventoryChecks', checks);
    return { success: true, changed, details };
}

async function stockInUnsafe(username, operator, body) {
    const { drugId, drugName, qty, batchNo, expiry, productionDate, supplier, cost, supplierId, unit, minStock, price, category } = body || {};
    const normalizedDrugName = String(drugName || '').trim();
    const qtyNum = toNum(qty);
    if (!normalizedDrugName || qtyNum <= 0) {
        throw new HttpError(400, '药品名称和数量不能为空，且数量必须大于0', 'VALIDATION_ERROR');
    }

    const inventory = await repo.readCollection(username, 'drugInventory');
    const drug = drugId
        ? inventory.find(d => String(d.id) === String(drugId))
        : inventory.find(d => d.name === normalizedDrugName);
    const existingCategory = normalizeInventoryCategory(drug && drug.category);
    const categoryRequired = !drug || !INVENTORY_CATEGORIES.includes(existingCategory);
    const requestedCategory = validateInventoryCategory(category, categoryRequired);
    if (drug && requestedCategory) drug.category = requestedCategory;
    const recordCategory = requestedCategory || existingCategory || '';
    if (!drug && !recordCategory) {
        throw new HttpError(400, '请选择药品类型，新入库药品必须归类', 'VALIDATION_ERROR');
    }

    let finalSupplierId = supplierId;
    if (supplier && !finalSupplierId) {
        const suppliers = await repo.readCollection(username, 'suppliers');
        let sup = suppliers.find(s => s.name === supplier);
        if (!sup) {
            sup = { id: newId(), name: supplier, contact: '', phone: '', address: '' };
            suppliers.push(sup);
            await repo.writeCollection(username, 'suppliers', suppliers);
        }
        finalSupplierId = sup.id;
    }

    if (drug) {
        drug.stock = toNum(drug.stock) + qtyNum;
        if (batchNo) drug.batchNo = batchNo;
        if (expiry) drug.expiry = expiry;
        if (productionDate) drug.productionDate = productionDate;
        if (supplier) drug.supplier = supplier;
        if (finalSupplierId) drug.supplierId = finalSupplierId;
        if (cost !== undefined && cost !== '') drug.costPrice = toNum(cost);
        if (price !== undefined && price !== '') drug.price = toNum(price);
        if (unit) drug.unit = unit;
        if (minStock !== undefined && minStock !== '') drug.minStock = toNum(minStock, 10);
        drug.purchaseDate = todayKey();
        drug.updatedAt = new Date().toISOString();
    } else {
        inventory.push({
            id: newId(),
            name: normalizedDrugName,
            category: recordCategory,
            stock: qtyNum,
            unit: unit || '盒',
            minStock: minStock || 10,
            batchNo: batchNo || '',
            expiry: expiry || '',
            productionDate: productionDate || '',
            purchaseDate: todayKey(),
            supplier: supplier || '',
            supplierId: finalSupplierId || '',
            costPrice: toNum(cost),
            price: toNum(price),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    await repo.writeCollection(username, 'drugInventory', inventory);

    const inRecords = await repo.readCollection(username, 'drugInRecords');
    inRecords.push({
        id: newId(),
        drugName: normalizedDrugName,
        category: recordCategory,
        qty: qtyNum,
        batchNo: batchNo || '',
        expiry: expiry || '',
        productionDate: productionDate || '',
        supplier: supplier || '',
        supplierId: finalSupplierId || '',
        cost: toNum(cost),
        date: new Date().toLocaleString(),
        operator
    });
    await repo.writeCollection(username, 'drugInRecords', inRecords);
    return { status: 201, data: { success: true } };
}

async function batchImportUnsafe(username, operator, body) {
    const items = (body && body.items) || [];
    if (!Array.isArray(items) || items.length === 0) {
        throw new HttpError(400, '导入数据不能为空', 'VALIDATION_ERROR');
    }

    const inventory = await repo.readCollection(username, 'drugInventory');
    const suppliers = await repo.readCollection(username, 'suppliers');
    const inRecords = await repo.readCollection(username, 'drugInRecords');
    let added = 0;
    let updated = 0;
    const seenNames = new Set();

    for (const item of items) {
        const name = String(item.name || '').trim();
        if (!name) continue;
        const existing = inventory.find(d => d.name === name);
        const existingCategory = normalizeInventoryCategory(existing && existing.category);
        const categoryRequired = !existing || !INVENTORY_CATEGORIES.includes(existingCategory);
        const requestedCategory = validateInventoryCategory(item.category, categoryRequired);
        if (existing && !requestedCategory && existing.category) {
            existing.category = normalizeInventoryCategory(existing.category);
        }
        const recordCategory = requestedCategory || existingCategory || '';
        if (!recordCategory) {
            throw new HttpError(400, `药品“${name}”缺少药品类型，Excel 导入药品必须填写分类`, 'VALIDATION_ERROR');
        }
        const key = name.toLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);

        const supName = (item.supplier || '').trim();
        let finalSupplierId = '';
        if (supName) {
            let existingSup = suppliers.find(s => s.name === supName);
            if (!existingSup) {
                existingSup = {
                    id: newId(),
                    name: supName,
                    contact: '',
                    phone: '',
                    address: '',
                    createdAt: new Date().toISOString()
                };
                suppliers.push(existingSup);
            }
            finalSupplierId = existingSup.id;
        }

        if (existing) {
            if (item.stock !== undefined && item.stock !== '') existing.stock = toNum(existing.stock) + Math.max(0, toNum(item.stock));
            if (item.price !== undefined && item.price !== '') existing.price = toNum(item.price);
            if (item.costPrice !== undefined && item.costPrice !== '') existing.costPrice = toNum(item.costPrice);
            if (item.batchNo) existing.batchNo = item.batchNo;
            if (item.expiry) existing.expiry = item.expiry;
            if (supName) existing.supplier = supName;
            if (finalSupplierId) existing.supplierId = finalSupplierId;
            if (item.manufacturer) existing.manufacturer = item.manufacturer;
            if (item.spec) existing.spec = item.spec;
            if (item.unit) existing.unit = item.unit;
            if (requestedCategory) existing.category = requestedCategory;
            if (item.code) existing.code = item.code;
            if (item.approvalNo) existing.approvalNo = item.approvalNo;
            if (item.productionDate) existing.productionDate = item.productionDate;
            if (Math.max(0, toNum(item.stock)) > 0) existing.purchaseDate = item.purchaseDate || todayKey();
            existing.updatedAt = new Date().toISOString();
            updated++;
        } else {
            inventory.push({
                id: newId(),
                name,
                code: item.code || '',
                approvalNo: item.approvalNo || '',
                spec: item.spec || '',
                unit: item.unit || '盒',
                category: recordCategory,
                manufacturer: item.manufacturer || '',
                stock: Math.max(0, toNum(item.stock)),
                minStock: item.minStock || 10,
                price: toNum(item.price),
                costPrice: toNum(item.costPrice),
                batchNo: item.batchNo || '',
                expiry: item.expiry || '',
                productionDate: item.productionDate || '',
                purchaseDate: item.purchaseDate || (Math.max(0, toNum(item.stock)) > 0 ? todayKey() : ''),
                supplier: supName || '',
                supplierId: finalSupplierId || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            added++;
        }

        const inQty = Math.max(0, toNum(item.stock));
        if (inQty > 0) {
            inRecords.push({
                id: newId(),
                drugName: name,
                category: recordCategory,
                qty: inQty,
                unit: item.unit || '盒',
                batchNo: item.batchNo || '',
                expiry: item.expiry || '',
                productionDate: item.productionDate || '',
                supplier: supName || '',
                cost: toNum(item.costPrice),
                date: new Date().toLocaleString(),
                operator,
                source: 'Excel导入'
            });
        }
    }

    await repo.writeCollection(username, 'drugInventory', inventory);
    await repo.writeCollection(username, 'suppliers', suppliers);
    await repo.writeCollection(username, 'drugInRecords', inRecords);
    return { success: true, added, updated, total: items.length };
}

async function deleteDrugsUnsafe(username, body) {
    const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : [];
    if (!ids.length) throw new HttpError(400, '请选择要删除的药品', 'VALIDATION_ERROR');
    const inventory = await repo.readCollection(username, 'drugInventory');
    const kept = inventory.filter(item => !ids.includes(String(item.id)));
    await repo.writeCollection(username, 'drugInventory', kept);
    const removed = inventory.filter(item => ids.includes(String(item.id)));
    const removedNames = new Set(removed.map(item => String(item.name || '').trim()).filter(Boolean));
    const pharmacy = await repo.readCollection(username, 'pharmacy');
    const pendingKept = pharmacy.filter(item => !(item.status !== '已发药' && removedNames.has(String(item.drug || '').trim())));
    if (pendingKept.length !== pharmacy.length) await repo.writeCollection(username, 'pharmacy', pendingKept);
    return {
        success: true,
        deleted: inventory.length - kept.length,
        pendingRemoved: pharmacy.length - pendingKept.length
    };
}

async function migrateLegacyCategoriesForStore(clinicId) {
    return repo.runWithStore(clinicId, () => repo.transaction(async () => {
        const inventory = await repo.readCollection('__clinic__', 'drugInventory');
        const inRecords = await repo.readCollection('__clinic__', 'drugInRecords');
        const result = migrateLegacyInventoryData(inventory, inRecords);
        if (result.inventoryUpdated) await repo.writeCollection('__clinic__', 'drugInventory', inventory);
        if (result.recordsUpdated) await repo.writeCollection('__clinic__', 'drugInRecords', inRecords);
        return { clinicId, ...result };
    }));
}

async function migrateLegacyCategories() {
    const clinicIds = repo.listStoreIds();
    const stores = [];
    for (const clinicId of clinicIds) {
        stores.push(await migrateLegacyCategoriesForStore(clinicId));
    }
    return {
        stores,
        inventoryUpdated: stores.reduce((sum, item) => sum + item.inventoryUpdated, 0),
        recordsUpdated: stores.reduce((sum, item) => sum + item.recordsUpdated, 0),
    };
}

async function checkInventory(username, operator, body) {
    return repo.transaction(() => checkInventoryUnsafe(username, operator, body));
}

async function stockIn(username, operator, body) {
    return repo.transaction(() => stockInUnsafe(username, operator, body));
}

async function batchImport(username, operator, body) {
    return repo.transaction(() => batchImportUnsafe(username, operator, body));
}

async function deleteDrugs(username, body) {
    return repo.transaction(() => deleteDrugsUnsafe(username, body));
}

module.exports = {
    INVENTORY_CATEGORIES,
    normalizeInventoryCategory,
    migrateLegacyInventoryData,
    migrateLegacyCategoriesForStore,
    migrateLegacyCategories,
    checkInventory,
    stockIn,
    batchImport,
    deleteDrugs
};
