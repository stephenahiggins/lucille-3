# Lucille Architecture Analysis

Lucille is a local-first screen-to-analysis pipeline. The important idea is that it has two layers:

1. Frame intelligence: what is visible in each individual frame.
2. Interconnected intelligence: how frames connect into sessions, repeated workflows, memory, skills, and wrap-up recommendations.

## System Overview

```mermaid
flowchart TD
  A["Screen Capture / Imported Frames"] --> B["Observation Records<br/>observations.jsonl"]
  B --> C["Per-Frame Visual Analysis<br/>Ollama qwen2.5vl:7b"]
  C --> D["Frame Analysis<br/>frame-analysis.jsonl"]

  D --> E["Session Analysis<br/>groups frames by time + focus"]
  D --> F["Activity Timeline<br/>clusters repeated work"]
  E --> G["Work Patterns<br/>inefficiency + savings"]
  F --> G

  G --> H["OpenAI Pattern Review + Recommendations<br/>default when API key is present"]
  H --> H1["Skill Proposals"]
  E --> I["User Memory Update"]
  F --> I
  H1 --> J["Optimization Wrap-Up"]

  I --> J
  G --> J
  E --> J

  J --> K["Markdown Report"]
```

## Local vs OpenAI

Per-frame vision remains local. Pattern review and recommendations use OpenAI by default when `OPENAI_API_KEY` is available.

```mermaid
flowchart LR
  A["Raw Frames"] --> B["Local Ollama Vision Model"]
  B --> C["Local JSON Artifacts"]
  C --> D["Local Session / Timeline Analysis"]
  D --> E["OpenAI Responses API<br/>pattern review + recommendations"]
  E --> F["Local Normalization<br/>work-patterns + skills"]
  F --> G["Local Report + Memory + Wrap-Up"]

  D -. "OPENAI=0 / --no-openai" .-> H["Local-only Synthesis"]
  H -. fallback / explicit opt-out .-> G
```

OpenAI receives local timeline/common-task summaries plus representative redacted frame evidence only. Full per-frame analysis remains local, and raw screenshots are not sent to OpenAI. Use `OPENAI=0` or `--no-openai` to force local-only synthesis.

## Core Data Flow

```mermaid
flowchart TD
  A["frame-analysis.jsonl"] --> B["Per-frame facts"]
  B --> B1["Visible applications"]
  B --> B2["Primary/focused app"]
  B --> B3["User intent"]
  B --> B4["Visited URLs"]
  B --> B5["Tasks + evidence"]

  A --> C["session-analysis.json"]
  C --> C1["Focus blocks"]
  C --> C2["Context switches"]
  C --> C3["Commands"]
  C --> C4["Session URLs"]

  A --> D["activity-timeline.json"]
  D --> D1["Repeated workflows"]
  D --> D2["Dwell time"]
  D --> D3["Cognitive hurdles"]

  C --> E["memory-update.json"]
  D --> E
  E --> E1["Regular tasks"]
  E --> E2["Frequent apps/sites"]
  E --> E3["Frequent commands"]
  E --> E4["Workflow improvements"]

  E --> F["OpenAI synthesis or local synthesis"]
  D --> F
  C --> F
  F --> G["optimization-wrap-up.json"]
```

## Interconnected Analysis

The interconnected layer does not re-look at pixels. It works over the structured per-frame output.

```mermaid
flowchart TD
  A["Frame 1<br/>Slack primary"] --> D["Session"]
  B["Frame 2<br/>GitHub primary"] --> D
  C["Frame 3<br/>VS Code primary"] --> D

  D --> E["Detected workflow:<br/>development review and reporting"]
  E --> F["Pattern:<br/>manual review + context switching"]
  F --> G["OpenAI-reviewed recommendation:<br/>next-action queue"]
  F --> H["OpenAI-reviewed skill proposal:<br/>review/reporting assistant"]
  F --> I["Memory:<br/>regular development workflow"]
```

## Generated Artifacts

```mermaid
flowchart LR
  A["storage/captures/<day>/observations.jsonl"] --> B["storage/analysis/<day>/frame-analysis.jsonl"]
  B --> C["session-analysis.json"]
  B --> D["activity-timeline.json"]
  C --> E["work-patterns.json"]
  D --> E
  E --> F["skill-proposals.json"]
  E --> G["task-skill-summary.json"]
  C --> H["memory-update.json"]
  D --> H
  F --> I["optimization-wrap-up.json"]
  H --> I
  I --> J["output/reports/<day>.md"]
```

## Privacy Boundary

```mermaid
flowchart TD
  A["Raw screen frames"] --> B["Local visual analysis"]
  B --> C["Redacted structured evidence"]

  C --> D["OpenAI synthesis<br/>redacted evidence only"]
  C --> E["Reports"]
  C --> F["Memory"]
  C --> G["Skills"]

  A -. "not included" .-> H["Markdown report"]
  A -. "not sent" .-> D
  I["Keystrokes / clipboard / audio / raw messages"] -. "not captured" .-> C
```

## Summary

Lucille uses local frame analysis to understand each screenshot, then connects those frames into sessions and repeated workflows. By default, when an OpenAI API key is available, the pattern review, recommendations, and skill portfolio are synthesized through OpenAI from redacted structured evidence only. The resulting work patterns, memory updates, skills, and wrap-up report are normalized and stored locally.
