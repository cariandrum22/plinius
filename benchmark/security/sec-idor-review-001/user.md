You are reviewing a REST API for a document-collaboration product. Authentication is handled by a gateway that injects a verified `X-User-Id` header. The team is confident authorization is "handled by login" and asks you to sanity-check a few endpoints before launch.

```python
@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str, request):
    user_id = request.headers["X-User-Id"]
    doc = db.documents.find_one({"_id": doc_id})
    return doc  # returns full document JSON

@app.get("/api/documents/{doc_id}/export")
def export_document(doc_id: str, request):
    doc = db.documents.find_one({"_id": doc_id})
    return render_pdf(doc)

@app.post("/api/documents/{doc_id}/share")
def share_document(doc_id: str, request, body):
    doc = db.documents.find_one({"_id": doc_id})
    doc["collaborators"].append(body["invitee_user_id"])
    db.documents.update_one({"_id": doc_id}, {"$set": doc})
    return {"ok": True}
```

Document IDs are sequential-ish and appear in shareable URLs. Review these endpoints for authorization defects. Explain the vulnerability class precisely, why it is exploitable here, and the impact. Then specify how authorization should be enforced for object access across this API in a way that generalizes beyond these three routes, rather than patching each endpoint individually. Note any trust assumptions about the gateway header that the team should make explicit.
