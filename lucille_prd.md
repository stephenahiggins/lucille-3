# Lucille PRD
## AI Productivity Intelligence for Administrative Work

**Version:** 0.1  
**Author:** OpenAI / ChatGPT  
**Date:** April 9, 2026  
**Status:** Draft

---

## 1. Overview

### Product name
**Lucille**

### Product tagline
**Lucille observes how work happens, identifies repetitive admin workflows, and recommends practical automations.**

### Summary
Lucille is a desktop-first productivity intelligence product designed to help administrative and knowledge workers understand where time is being lost in repetitive digital workflows.

The product passively observes high-level user activity such as:
- active application
- active window title
- session duration
- app switching
- repeated workflow sequences
- browser domain context during explicit workflow recording

Lucille then turns this activity metadata into:
- workflow summaries
- inefficiency signals
- automation recommendations
- a daily or on-demand optimization report

Lucille is intended to begin as a local-first, privacy-constrained founder MVP for macOS, with a likely expansion path toward Windows and enterprise deployment.

---

## 2. Problem Statement

Modern administrative work is fragmented across many SaaS tools, browser tabs, spreadsheets, messaging apps, and systems of record. Users often repeat the same manual workflows every day without visibility into:
- how often those workflows occur
- how much time they consume
- how much switching overhead they create
- which workflows could be automated or simplified

Existing tools generally fall into one of three categories:
1. Time tracking tools — show time spent, but not meaningful workflow insight
2. Employee monitoring tools — focus on oversight rather than value creation
3. Automation tools — require the user to know what to automate before value is created

Lucille aims to fill the gap by becoming a workflow intelligence layer:
- observe work patterns
- identify repetitive manual effort
- recommend automations or better ways of working

---

## 3. Vision

Lucille becomes the system that helps organizations answer:

> “Where is human time being spent on repetitive digital admin, and what should we automate next?”

Over time, Lucille could evolve from:
- activity logging
to
- workflow understanding
to
- automation recommendations
to
- workflow recording
to
- agent-assisted execution

---

## 4. Goals

### Primary goal
Help users identify and reduce repetitive administrative work through metadata-based workflow analysis and automation recommendations.

### MVP goals
1. Capture useful activity metadata from a user’s workday
2. Turn that data into interpretable workflows and inefficiency signals
3. Produce a pitch-worthy report that demonstrates clear value
4. Support a deterministic demo mode for founder and investor presentations

### Non-goals for MVP
- Hidden surveillance
- Keystroke logging
- Clipboard capture
- Screenshot capture
- Full browser content scraping
- Fully autonomous workflow execution
- Enterprise fleet deployment
- Multi-user management
- Cloud sync or shared analytics

---

## 5. Target Users

### Primary initial user
Administrative and operational users in UK education settings.

Examples:
- attendance officers
- school administrators
- data managers
- senior admin staff
- MAT central operations staff

### Secondary future users
- operations staff in professional services
- HR and finance administrators
- customer operations teams
- healthcare administrative staff
- public sector back-office staff

---

## 6. Jobs To Be Done

### Core functional job
**When I spend my day moving between systems and repeating admin tasks, I want Lucille to identify where my time is being wasted and suggest better ways of working.**

### Supporting jobs
- Help me understand which workflows are repetitive
- Help me quantify time lost to switching and manual steps
- Help me spot automation opportunities
- Help me explain the problem to a manager or buyer
- Help me record a workflow explicitly when I want deeper analysis

### Emotional jobs
- Reduce frustration from repetitive digital admin
- Feel more in control of my day
- Feel that technology is helping me, not watching me

---

## 7. User Personas

### Persona 1: School Data Manager
Works across:
- MIS
- spreadsheets
- reporting tools
- email
- browser tabs

Pain points:
- repeated exports
- reporting prep
- cross-system reconciliation
- lots of browser switching

Success for this user:
- Lucille identifies repeated reporting workflows and suggests automation opportunities

### Persona 2: Attendance Officer
Works across:
- MIS attendance views
- email / parent comms
- messaging
- spreadsheets

Pain points:
- repeated attendance follow-up
- switching between case lists, parent messages, and notes
- repetitive exception handling

Success for this user:
- Lucille identifies attendance admin loops and suggests templates or workflow consolidation

### Persona 3: Founder / Design Partner Demo Viewer
Not necessarily an end user yet.

Needs:
- a clear report
- obvious before-and-after value
- believable workflow labels
- quantified inefficiency

Success for this persona:
- can immediately see what Lucille does and why it matters

---

## 8. Product Principles

1. **Value over surveillance**  
   Lucille must feel like a productivity assistant, not an employee monitoring tool.

2. **Metadata-first**  
   MVP should rely on app names, window titles, sessions, and explicit recording metadata rather than raw content capture.

3. **Local-first and transparent**  
   All captured data should remain local in the MVP, with clear explanation of what is and is not recorded.

4. **Interpretation matters more than instrumentation**  
   Raw logs are not the product. Lucille must translate activity into insight.

5. **Demo quality matters**  
   Early versions should optimize for a compelling founder narrative and design-partner conversations.

---

## 9. Scope

### In scope for MVP

#### Passive activity capture
- frontmost app name
- active window title where available
- timestamp
- session grouping
- app switching
- optional ignored apps list

#### Workflow analysis
- time by app
- time by session
- context switching count
- repeated sequence detection
- focus block detection
- likely repetitive manual workflow detection
- workflow category classification

#### Recommendation engine
Rules-based recommendations such as:
- repetitive reporting workflow
- heavy browser-based admin workflow
- repeated email / communication activity
- repeated back-and-forth workflow
- potential automation candidate

#### Reporting
- machine-readable analysis output
- polished local HTML report
- summary metrics
- top insights
- suggested automations
- weekly time-saving estimate

#### Demo mode
- deterministic sample activity dataset
- deterministic sample session dataset
- demo report generation via CLI

#### Explicit workflow recording mode
- user manually starts recording
- mouse movement summaries
- click event capture
- browser domain / tab context where available
- workflow recording session summaries

### Out of scope for MVP
- raw typed text capture
- clipboard capture
- screenshots
- OCR
- DOM or document scraping
- full URL capture including sensitive query params
- cloud synchronization
- SaaS analytics backend
- Windows support in the first shipped MVP
- production packaging and enterprise fleet controls

---

## 10. Core User Flows

### Flow 1: Passive daily activity capture
1. User runs Lucille locally
2. Lucille polls frontmost app and active window title
3. Lucille writes activity events to local log files
4. Lucille groups events into sessions
5. User later runs analysis or report generation
6. Lucille produces a summary of workflows and inefficiencies

### Flow 2: Generate an optimization report
1. User runs `npm run report`
2. Lucille reads the activity and session logs
3. Lucille normalizes and classifies workflows
4. Lucille generates insights and recommendations
5. Lucille outputs `analysis.json` and `report.html`

### Flow 3: Demo mode
1. User runs `npm run demo:report`
2. Lucille loads seeded demo data
3. Lucille generates a deterministic pitch report
4. Founder presents the report to investors or design partners

### Flow 4: Explicit workflow recording
1. User starts recording mode manually
2. Lucille logs:
   - app/window context
   - click events
   - mouse movement summaries
   - browser domain context where possible
3. User stops recording
4. Lucille generates a workflow recording session summary
5. Lucille uses that data as additional input into workflow analysis

---

## 11. Functional Requirements

### 11.1 Activity logging
Lucille must:
- run locally from the command line
- poll the frontmost app
- capture the active window title where possible
- write structured JSONL events to disk
- avoid duplicate writes by default
- shut down cleanly and finalize open sessions

### 11.2 Sessionization
Lucille must:
- group adjacent activity into sessions
- track session start and end time
- compute duration in seconds
- write completed sessions to a JSONL file

### 11.3 Analysis
Lucille must:
- read existing logs
- normalize titles
- aggregate time by app
- aggregate time by workflow
- compute app switch counts
- detect repeated app/window combinations
- identify multi-step workflow patterns
- label likely workflow categories

### 11.4 Recommendations
Lucille must generate human-readable insights with:
- title
- description
- evidence
- confidence score
- estimated weekly time saving
- suggested action

### 11.5 HTML report
Lucille must generate a local report containing:
- summary metrics
- top apps by time
- workflow categories
- repeated patterns
- top inefficiency signals
- recommendations
- estimated weekly time savings
- concise narrative summary

### 11.6 Demo mode
Lucille must support a deterministic demo mode with:
- seeded sample activity
- seeded sample sessions
- predictable report output

### 11.7 Explicit recording mode
Lucille must support manually started recording mode that captures:
- click events
- mouse movement summaries
- redacted keystroke metadata
- active browser domain context where possible
- recording session metadata and summary

---

## 12. Non-Functional Requirements

### Privacy
- Local-first data storage
- Transparent capture model
- No hidden content interception
- Clear explanation of limitations and boundaries

### Reliability
- Graceful failure if window titles or browser context are unavailable
- Continue operating even when individual signals fail
- No crashes on missing permissions

### Performance
- Lightweight background operation
- Limited CPU and memory usage
- Reasonable polling intervals

### Simplicity
- Plain JavaScript
- Minimal dependencies
- Easy local setup
- CLI-first workflow

### Extensibility
- New heuristics should be easy to add
- Report templates should be modifiable
- Recording mode should be optional

---

## 13. Data Model

### Activity event
Fields may include:
- timestamp
- app_name
- window_title
- source
- poll_interval_ms
- changed

### Session
Fields may include:
- app_name
- window_title
- start_time
- end_time
- duration_seconds

### Insight
Fields may include:
- id
- type
- title
- description
- evidence
- confidence_score
- estimated_time_saving_minutes_per_week
- suggested_action

### Recording interaction event
Fields may include:
- timestamp
- event_type
- x
- y
- button
- key_code
- modifiers
- keystroke_type
- key_display
- text_input_redacted
- distance_delta
- app_name
- window_title
- domain
- recording_session_id

### Recording session
Fields may include:
- recording_session_id
- start_time
- end_time
- duration_seconds
- apps
- domains
- click_count
- mouse_move_events
- keystroke_count
- shortcut_count
- summary

---

## 14. Heuristics and Intelligence Model

Lucille’s MVP intelligence layer will be rules-based, not fully AI-native.

### Initial heuristics
1. High context switching
2. Repeated return to the same app/window
3. Repeated multi-step workflow sequence
4. Long focus block in a single tool
5. Likely manual reporting behaviour
6. Likely parent communication or email repetition
7. Browser-heavy administrative workflow
8. Potential automation candidate based on repetition frequency

### Example workflow labels
- Attendance administration
- Parent communication
- Reporting and exports
- MIS navigation
- Data reconciliation
- Safeguarding administration
- Messaging and coordination
- General browser research

---

## 15. UX / Output Requirements

Lucille’s primary UX in the MVP is not an app shell, but an output experience.

### Required outputs
- terminal feedback while running
- machine-readable JSON analysis
- polished HTML report
- readable README and demo instructions

### Report tone
The report should feel:
- clear
- practical
- professional
- founder-demo ready
- not creepy
- not over-claiming

Example framing:
- “Lucille identified several repeated admin patterns”
- “This workflow appears to recur multiple times”
- “This may be a strong candidate for templating or automation”

Avoid:
- “We monitored everything you did”
- “AI knows exactly what you were thinking”
- exaggerated certainty

---

## 16. Success Metrics

### MVP success
- Lucille can reliably generate a report from sample or real data
- The report contains at least 3–5 believable insights
- Founder can demo Lucille in under 5 minutes
- Design partners understand the value proposition quickly
- Stakeholders describe the product as workflow intelligence rather than monitoring

### Qualitative success criteria
- “I can see how this would help identify wasted admin time”
- “This feels useful, not creepy”
- “I can imagine using this to find automation opportunities”
- “This is more interesting than time tracking”

---

## 17. Risks

### Product risk
The product may look too much like monitoring unless insight quality is high.

### Technical risk
macOS permissions and OS limitations may make some signals inconsistent.

### Data quality risk
Window titles may be noisy, missing, or insufficiently descriptive.

### Trust risk
If the framing is wrong, users may interpret the product as surveillance.

### Demo risk
If the founder relies only on live laptop activity, the demo may be weak or noisy.

---

## 18. Mitigations

- Keep the product metadata-first
- Use explicit, visible workflow recording mode
- Ship seeded demo data
- Emphasize recommendations and time savings
- Avoid invasive data capture
- Use education-oriented classification to make insights feel concrete

---

## 19. Roadmap

### Phase 1 — Logger foundation
- app/window capture
- sessionization
- local JSONL logging

### Phase 2 — Workflow intelligence
- normalization
- heuristics engine
- repeated sequence detection
- category classification

### Phase 3 — Report generation
- analysis output
- HTML report
- demo mode

### Phase 4 — Explicit recording mode
- click capture
- mouse movement summaries
- browser domain context
- workflow recording summaries

### Phase 5 — Future productization
- Windows agent
- packaged desktop app
- enterprise deployment model
- shared team analytics
- workflow recommendation marketplace
- automation execution or agent layer

---

## 20. Open Questions

1. How much browser metadata can be captured reliably on macOS without harming trust?
2. What is the best way to classify education workflows from noisy titles?
3. How much of the early value can be proven with metadata alone?
4. Should the first commercial wedge be individual users, teams, or design partners?
5. When does workflow recording move from a pitch feature to a core feature?

---

## 21. Recommendation

Lucille should be built first as a privacy-constrained, founder-demo-ready workflow intelligence MVP.

The key to success is not broader instrumentation.  
It is stronger interpretation.

Lucille will be compelling when it can clearly show:
- what repetitive work happened
- how much time it cost
- why it matters
- what could be automated next

That is the core product promise.

---

## 22. Appendix: Suggested CLI Commands

```bash
npm install
npm run dev
npm run analyze
npm run report
npm run demo:report
node src/index.js --record=true
```

### Suggested output files

```text
logs/activity.jsonl
logs/sessions.jsonl
logs/interaction_events.jsonl
logs/recording_sessions.jsonl
output/analysis.json
output/report.html
```
