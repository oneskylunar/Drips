/*
    --> Author: ONESKYLUNAR
    --> File: database/tables/queue.js
    --> Description: Database schema for persisting enqueued queue tasks.
                     Ensures queued replies survive unexpected shutdowns.
*/

// ---====================< START >====================---

export default {
    name: "queue",
    primaryKey: "id",
    storage: "individual",
    timestamps: true,
    columns: {
        id: { type: "string", default: null },
        chatId: { type: "string", default: null },
        payload: { type: "object", default: {} },
        options: { type: "object", default: {} },
        createdAt: { type: "number", default: null },
        ttl: { type: "number", default: 60000 }
    }
};

// ---====================< END >====================---
