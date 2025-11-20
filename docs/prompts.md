# Benchmark Prompts Guide

This document describes how to create and manage benchmark prompts for the Plinius evaluation system.

## Directory Structure

```
benchmark/
└── prompt/
    ├── A1.md    # Quantitative Finance
    ├── A2.md
    ├── A3.md
    ├── B1.md    # Formal Verification
    ├── B2.md
    ├── B3.md
    ├── C1.md    # Business Strategy
    ├── C2.md
    └── C3.md
```

## Prompt ID Convention

Prompts follow the naming pattern `{Category}{Number}.md`:

| Prefix | Category | Description |
|--------|----------|-------------|
| A | Quantitative Finance | Mathematical modeling, algorithms, statistics |
| B | Formal Verification | Type theory, proof systems (Coq, F*) |
| C | Business Strategy | Decision analysis, strategic reasoning |

## Prompt Format

Each prompt is a Markdown file with the following structure:

```markdown
# Title of the Problem

Brief role/context setting (e.g., "You are a quantitative researcher.")

## Problem Description

Detailed description of the task with:
- Background information
- Specific constraints
- Input data (if applicable)

## Tasks

Numbered list of specific tasks:
1. First task
2. Second task
3. ...

## Response Guidelines

- Answer in English
- Think step by step
- Structure your reasoning clearly
```

### Example Prompt Structure

```markdown
# Abstract Market Generation Model Estimation

You are a quantitative researcher.

We observe a synthetic daily return series...

Your task is to:
1. Infer plausible candidate stochastic processes...
2. Propose at least two alternative model classes...
3. Describe how you would estimate their parameters.
4. Explain how you would avoid overfitting...
5. Provide a concrete plan for out-of-sample testing.

Answer in English.
Think step by step and structure your reasoning clearly.

Here is the data:
...
```

## Adding New Prompts

Simply create a new `.md` file in `benchmark/prompt/` with the appropriate ID:

```bash
# Example: Adding a new Quantitative prompt
touch benchmark/prompt/A4.md
```

**That's it!** The system automatically discovers all `.md` files in the prompt directory.

### Naming Convention

- **A prefix**: Quantitative Finance (e.g., A1, A2, A4)
- **B prefix**: Formal Verification (e.g., B1, B2, B4)
- **C prefix**: Business Strategy (e.g., C1, C2, C4)
- Custom prefixes default to Quantitative category

### Title Extraction

The benchmark title is automatically extracted from the first `# Heading` in your prompt file. If no heading is found, the filename is used as the title.

### Configuration (Optional)

To modify which models are benchmarked or used as evaluators, edit `src/config.ts`:

```typescript
// Models to benchmark
export const BENCHMARK_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_HAIKU,
  // Add or remove models here
];

// Models to use as evaluators
export const EVALUATOR_MODELS: OpenRouterModel[] = [
  OpenRouterModels.GPT_5_1,
  OpenRouterModels.CLAUDE_4_5_SONNET,
  OpenRouterModels.GEMINI_2_5_PRO,
];
```

## Evaluation Rubric

Each response is evaluated on 5 dimensions (0-5 points each, 25 total):

### 1. Structure (0-5)
- Clear organization and logical flow
- Appropriate use of sections and formatting
- Easy to follow and navigate

### 2. Depth (0-5)
- Thorough exploration of the problem
- Consideration of edge cases and alternatives
- Deep understanding of underlying principles

### 3. Consistency (0-5)
- Internal coherence across the response
- No contradictions
- Aligned assumptions throughout

### 4. Creativity (0-5)
- Novel approaches and insights
- Concrete, illustrative examples
- Goes beyond surface-level analysis

### 5. Domain Correctness (0-5)
- Technical accuracy
- Correct use of domain terminology
- Valid mathematical/logical reasoning

## Design Guidelines

### Do
- **Be specific**: Provide concrete numbers, constraints, and data
- **Require structured reasoning**: Ask for step-by-step analysis
- **Include multiple sub-tasks**: Test different aspects of reasoning
- **Set clear success criteria**: Define what a good answer looks like
- **Use realistic scenarios**: Ground problems in practical contexts

### Don't
- **Avoid trivial problems**: Should require genuine reasoning
- **Don't be vague**: Ambiguous prompts lead to inconsistent evaluation
- **Avoid yes/no questions**: Open-ended responses are more informative
- **Don't test pure knowledge recall**: Focus on reasoning ability

### Difficulty Calibration

- **Target audience**: Expert-level practitioners
- **Expected response length**: 1,000-5,000 words
- **Time to answer well**: 30-60 minutes for a human expert
- **Success rate expectation**: Top models should score 20+/25

## Categories in Detail

### Category A: Quantitative Finance & Algorithms

Focus areas:
- Stochastic process modeling
- Portfolio optimization
- Risk decomposition
- Time series analysis
- Parameter estimation

Key skills tested:
- Mathematical rigor
- Statistical reasoning
- Algorithmic thinking
- Model comparison

### Category B: Formal Verification

Focus areas:
- Type theory (Coq, F*, Agda)
- Proof construction
- Program verification
- Security properties
- Monadic effects

Key skills tested:
- Formal reasoning
- Type-level programming
- Proof strategy design
- Abstraction design

### Category C: Business Strategy & Decision Making

Focus areas:
- Decision trees
- Causal modeling
- Strategic analysis
- Uncertainty quantification
- Organizational dynamics

Key skills tested:
- Systems thinking
- Quantitative reasoning
- Communication clarity
- Practical applicability

## Running Benchmarks

After adding prompts:

```bash
# Run all benchmarks
npx tsx src/cli.ts benchmark

# Run evaluation
npx tsx src/cli.ts evaluate

# Generate comparison report
npx tsx src/cli.ts compare
```

## Notes

- Prompts are not tracked in git to allow customization
- Copy example prompts from documentation to get started
- The evaluation rubric is consistent across all categories
- Multiple evaluators (GPT-5.1, Claude, Gemini) are used for cross-validation
