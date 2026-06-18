/*
    --> Author: ONESKYLUNAR
    --> File: src/middleware/_template.js
    --> Description: Middleware template. Copy and rename to create a new middleware.
                     Files starting with _ are ignored by the middleware loader.
                     Middlewares run in alphabetical filename order before plugins.
*/

// ----------> Template middleware — copy and rename <----------
export default async function templateMiddleware(m, sock, db) {
    // m    = Serialized message object
    // sock = Baileys socket instance
    // db   = Database instance

    // Return true to consume the message (stops further processing)
    // Return false/undefined to pass to next middleware → plugins

    return false;
}
