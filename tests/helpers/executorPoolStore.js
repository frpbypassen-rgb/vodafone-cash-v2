'use strict';

const store = {
    groups: new Map(),
    employees: new Map(),
    pools: new Map(),
    transactions: [],
    notifications: []
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const matchesFilter = (doc, filter = {}) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((clause) => matchesFilter(doc, clause));
    if (key === '$and') return expected.every((clause) => matchesFilter(doc, clause));
    const actual = doc[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
            return String(actual || '') !== String(expected.$ne || '');
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
            return expected.$in.map(String).includes(String(actual));
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            const exists = actual !== undefined && actual !== null;
            return expected.$exists ? exists : !exists;
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$gte')) {
            return Number(actual || 0) >= Number(expected.$gte);
        }
    }
    if (expected === null) return actual === null || actual === undefined;
    return String(actual) === String(expected);
});

const applyInc = (doc, update = {}) => {
    if (update.$inc) {
        Object.entries(update.$inc).forEach(([key, amount]) => {
            doc[key] = Number(doc[key] || 0) + Number(amount);
        });
    }
    if (update.$set) Object.assign(doc, update.$set);
    return doc;
};

const persistable = (map, id, extra = {}) => {
    const current = map.get(String(id));
    const doc = { ...current, ...extra };
    return {
        ...doc,
        async save() {
            const { save, ...rest } = this;
            map.set(String(this._id), { ...rest });
            return this;
        }
    };
};

const makeCollectionModel = (mapName) => {
    const map = () => store[mapName];
    return {
        async create(data) {
            const doc = { _id: data._id || `${mapName}-${map().size + 1}`, archivedAt: null, balance: 0, ...data };
            map().set(String(doc._id), doc);
            return persistable(map(), doc._id);
        },
        find(filter) {
            const rows = [...map().values()].filter((doc) => matchesFilter(doc, filter));
            const documents = rows.map((doc) => persistable(map(), doc._id));
            const promise = Promise.resolve(documents);
            return {
                select() { return this; },
                sort() { return this; },
                lean: async () => rows.map(clone),
                then: (resolve, reject) => promise.then(resolve, reject),
                catch: (reject) => promise.catch(reject)
            };
        },
        findOne(filter) {
            const row = [...map().values()].find((doc) => matchesFilter(doc, filter)) || null;
            return {
                select() { return this; },
                lean: async () => (row ? clone(row) : null)
            };
        },
        findById(id) {
            const raw = map().get(String(id)) || null;
            const doc = raw ? persistable(map(), id) : null;
            const promise = Promise.resolve(doc);
            return {
                select() { return this; },
                lean: async () => (raw ? clone(raw) : null),
                then: (resolve, reject) => promise.then(resolve, reject)
            };
        },
        async findByIdAndUpdate(id, update, options = {}) {
            const doc = map().get(String(id));
            if (!doc) return null;
            applyInc(doc, update);
            return options.new ? clone(doc) : clone(doc);
        },
        async findOneAndUpdate(filter, update, options = {}) {
            const doc = [...map().values()].find((item) => matchesFilter(item, filter));
            if (!doc) return null;
            applyInc(doc, update);
            return options.new ? clone(doc) : clone(doc);
        },
        async countDocuments(filter) {
            return [...map().values()].filter((doc) => matchesFilter(doc, filter)).length;
        }
    };
};

const resetStore = () => {
    store.groups.clear();
    store.employees.clear();
    store.pools.clear();
    store.transactions = [];
    store.notifications = [];
};

module.exports = {
    applyInc,
    makeCollectionModel,
    matchesFilter,
    resetStore,
    store
};
