A background worker accepts messages from a queue and a small internal API accepts uploaded "session" blobs. A developer implemented both using native serialization for convenience and asks for a review before it is exposed more widely.

```python
import pickle, yaml, base64

def handle_queue_message(raw: bytes):
    # messages are base64-encoded pickled dicts
    obj = pickle.loads(base64.b64decode(raw))
    return process(obj)

def load_session(upload: str):
    # session state uploaded as YAML
    state = yaml.load(upload)          # PyYAML, default loader
    return restore(state)
```

Context: the queue is "internal" but several services and a partner integration can publish to it; the session upload endpoint is authenticated but available to all logged-in users. The team says "the data is our own format, so it's fine".

Review these two deserialization paths. Explain the vulnerability class and why deserializing untrusted input with these mechanisms is dangerous (what an attacker who controls the bytes can achieve), and why the "it's our own format" and "it's internal" assumptions are unsafe. Then specify safe alternatives for transporting and reconstructing structured data across a trust boundary, including how to choose formats and validate the reconstructed data, and what to do about the existing serialized data. Point to the specific dangerous calls.
