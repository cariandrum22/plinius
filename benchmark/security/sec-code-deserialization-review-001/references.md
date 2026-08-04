## Intent
Probes recognition of insecure deserialization (pickle, unsafe YAML loader) as a code-execution class and the ability to prescribe safe data-interchange and validation across trust boundaries.

## Assumptions
Native serialization is used across a trust boundary that includes partner and general-user input; the reviewer treats untrusted deserialization via these mechanisms as remote-code-execution risk. The 'internal' framing is not a real boundary.

## Reviewer notes
A strong answer identifies both pickle.loads and the default yaml.load as code-execution sinks, dismantles the 'internal/our format' assumption by tracing who can publish, prescribes a safe interchange format with schema validation, and addresses migrating existing data. A weak answer only flags one path, suggests 'sanitizing' the pickled input, or trusts the internal framing.
