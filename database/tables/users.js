/*
    --> Author: ONESKYLUNAR
    --> File: database/tables/users.js
    --> Description: User schema for the Redis database engine.
*/

// ---====================< START >====================---

export default {
    name: "users",
    primaryKey: "id",
    storage: "individual",
    timestamps: true,
    columns: {
        id: { type: "string", default: null },
        name: { type: "string", default: "Unknown User" },
        xp: { type: "number", default: 0 },
        isBanned: { type: "boolean", default: false },
        role: { type: "string", default: "user" }
    }
};

// ---====================< END >====================---
