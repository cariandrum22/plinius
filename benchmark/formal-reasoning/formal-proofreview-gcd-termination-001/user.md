# Review a Termination Proof Sketch for the Euclidean GCD

Consider the subtractive Euclidean algorithm:

```
gcd(a, b):            # a, b are positive integers
    while a != b:
        if a > b: a = a - b
        else:      b = b - a
    return a
```

A student submits this proof sketch that the loop **terminates and returns
gcd(a,b)**:

> "Each iteration replaces the larger of a, b by their difference, so the values
> shrink. Since they are positive integers and keep shrinking, the loop must stop.
> When it stops, a == b, and since subtracting never changes the gcd, the returned
> value equals the original gcd. Therefore the algorithm is correct."

Your task is to review this sketch as a careful referee.

Please produce:

1. An assessment of the **termination** argument. "The values shrink" is vague:
   give a precise **variant/measure** (a quantity that is a natural number and
   strictly decreases every iteration) and check the sketch actually justifies
   strict decrease each iteration. Point out whether the sketch handles the case
   where one value is much larger than the other (many iterations) and why the
   measure still works.

2. An assessment of the **partial-correctness** claim "subtracting never changes
   the gcd". Is this stated as an invariant? What is the precise invariant, and
   does the sketch justify it, or merely assert it? Identify the mathematical
   fact it relies on (gcd(a,b) = gcd(a-b, b) for a > b).

3. A verdict: is the conclusion **true**, and is the sketch a **rigorous proof**?
   Separate 'the algorithm is correct' from 'this argument establishes it'.
   Precisely list what must be added (measure + invariant, and the missing
   justification of the gcd fact) to make it rigorous. Do not rewrite the whole
   proof; identify the gaps.

State your assumptions.
