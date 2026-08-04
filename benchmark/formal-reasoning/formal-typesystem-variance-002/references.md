## Intent

Probes analyzing whether a proposed subtyping rule for a mutable generic is sound, and classifying sound variance for read-only, write-only, and read-write forms.

## Assumptions

Assume nominal subtyping with subsumption, a class hierarchy including Cat<:Animal and Dog<:Animal with Cat and Dog unrelated, and standard method-typing where covariant return / contravariant parameter is the sound baseline.

## Reviewer notes

A strong answer defines soundness operationally, exhibits the exact subsumption step that admits an ill-typed value through an aliased supertype view and names the position responsible, then classifies variance for the read-only, write-only, and read-write forms with reasons tied to the offending operation. A weak answer merely asserts covariance is bad, offers a trace that never actually type-checks, or mislabels the variance of one of the forms.
