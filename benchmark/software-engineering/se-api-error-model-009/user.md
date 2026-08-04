## Context

You maintain a REST API, written in TypeScript on top of a Node.js HTTP framework, that has grown over several years with different teams owning different route modules. Each module implemented its own error handling independently, and there was never a shared convention. External developers integrating against the API have complained that they cannot write reliable error-handling code against it, because the shape of an error response depends on which endpoint produced it.

Here are representative examples pulled directly from current production responses:

**`POST /v1/users` — missing required field, `400 Bad Request`:**
```json
{ "error": "email is required" }
```

**`GET /v1/orders/:id` — order does not exist, `404 Not Found`:**
```json
{ "message": "Order not found", "code": 404 }
```

**`POST /v1/sessions` — bad credentials, `401 Unauthorized`:**
```json
{ "error": { "type": "AuthError", "detail": "Invalid token" } }
```

**`POST /v1/orders` — too many requests, `429 Too Many Requests`, `Content-Type: text/plain`:**
```
Too many requests, please slow down
```

**`POST /v1/payments` — unhandled exception, `500 Internal Server Error`:**
```json
{
  "message": "TypeError: Cannot read properties of undefined (reading 'id')",
  "stack": "TypeError: Cannot read properties of undefined (reading 'id')\n    at chargeHandler (/app/src/routes/payments.ts:42:19)\n    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)"
}
```

**`POST /v1/users` — multiple validation failures at once, `400 Bad Request`:**
```json
{ "error": "email is required, password must be at least 8 characters" }
```

Each route module currently defines its own ad hoc error handler (some throw plain `Error` objects caught by Express's default handler, some construct custom error classes with different shapes, some format directly in the route function), and there is no shared type or schema that response bodies are checked against before being sent.

## Deliverable

Design a single, coherent, machine-readable error response model to be used consistently across every endpoint in this API going forward. Your design should specify:

1. **Response envelope** — the exact shape of an error response body (as a TypeScript type/interface), used uniformly regardless of which endpoint or failure produced it.
2. **Error code taxonomy** — a scheme for machine-readable error identifiers (distinct from the HTTP status code and from any human-readable message) and how these identifiers map to HTTP status codes.
3. **Validation errors** — how a single response communicates one or more field-level validation failures at once, in a form a client can programmatically map back to the offending fields.
4. **Client guidance** — what additional information, if any, the response should carry to help a caller decide what to do next (e.g., whether to retry, which field to correct, where to find more detail), and what must never appear in a response body regardless of environment.
5. **Evolvability** — how new error conditions can be introduced over time without breaking existing client integrations, and how you would define behavior for a client that receives an error identifier it does not recognize.

Justify each significant choice, and note any case among the examples above that your model handles differently from how it is currently handled today, and why.
