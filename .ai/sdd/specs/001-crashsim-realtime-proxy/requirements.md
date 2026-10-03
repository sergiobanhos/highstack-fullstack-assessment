# Feature: Crashsim real-time operator proxy

> Status: Approved
> Source: User request, `README.md`, and `ASSESSMENT.md`

## Overview

The operator connects to the Crashsim engine on the server, keeps its credentials private, and relays authoritative game state to clients over SSE. A minimal React debug client makes the connection status, current snapshot, and received event stream visible while the integration is developed. This delivery supports Crashsim only. The system must recover from stream interruption and delayed or out-of-order events without showing a round moving backward.

## Business Context

The operator is a critical boundary for a real-time game involving money. A frozen or regressing game state can cause a player to make a decision using stale information. The service must make connection health visible and resume from an authoritative snapshot after reconnecting. The debug client provides a small end-to-end view for verifying that behavior; it is not yet a gameplay client.

## User Stories

### US-001: Follow the current game state

**As a** player
**I want to** receive the current round and multiplier through the operator
**So that** my browser never needs direct access to the game engine.

**Acceptance Criteria:**
- [ ] A connected client receives a current-state snapshot and subsequent live Crashsim events from the operator.
- [ ] The client receives no engine credentials and does not connect directly to Crashsim.
- [ ] The event envelope retains the round identity and sequence needed to identify stale updates.

### US-002: Recover after a stream interruption

**As a** player
**I want to** see when game state is stale and have the operator resynchronize
**So that** a temporary engine outage does not leave me acting on a false live state.

**Acceptance Criteria:**
- [ ] On upstream disconnect, clients are told the stream is reconnecting.
- [ ] The last known round is frozen and bet/cashout actions are disabled until synchronization completes.
- [ ] After reconnecting, the operator obtains the current engine snapshot and resumes from it.

### US-003: Inspect the Crashsim integration

**As an** operator maintainer
**I want to** see connection health, the current round snapshot, and events received by the operator in a minimal browser client
**So that** I can verify the engine-to-operator-to-client stream end to end.

**Acceptance Criteria:**
- [ ] The client displays whether the operator is connected, reconnecting, or synchronizing with the engine.
- [ ] The client displays the latest round snapshot, including the round ID, state, sequence, and multiplier when available.
- [ ] The client prints received events with their type, sequence, and round ID when available.
- [ ] During an upstream interruption, the client freezes the last known state and visibly indicates reconnection; after synchronization, it displays the replacement snapshot.
- [ ] The client is a plain React debug view with no gameplay actions or visual styling requirements.

## Functional Requirements

### FR-001: Keep the engine behind the operator — Must Have

WHEN a downstream client requests game state
THE SYSTEM SHALL serve that state through the operator
SO THAT provider credentials and engine access remain server-side.

### FR-002: Maintain one upstream stream — Must Have

WHEN the operator process is running
THE SYSTEM SHALL maintain one Crashsim stream connection per process, independent of the number of connected browsers
SO THAT clients do not multiply upstream connections.

### FR-003: Relay validated Crashsim events — Must Have

WHEN the engine sends a supported event
THE SYSTEM SHALL validate its envelope and relay it to operator clients with its `roundId` and `seq`
SO THAT clients can render real-time state and reject stale updates.

### FR-004: Synchronize on connection and reconnect — Must Have

WHEN an upstream stream connection is established or restored
THE SYSTEM SHALL synchronize from `GET /rounds/current` and then apply applicable newer events
SO THAT the operator resumes from authoritative current state.

### FR-005: Keep round state moving forward — Must Have

WHEN an event arrives late or out of order
THE SYSTEM SHALL prevent it from regressing the current round state
SO THAT a `tick` received after `round.crashed` cannot make the same round appear to be running again.

### FR-006: Report upstream health — Must Have

WHEN the upstream stream disconnects, reconnects, or finishes synchronization
THE SYSTEM SHALL expose the corresponding connection state to clients
SO THAT clients can distinguish live state from stale state.

### FR-007: Keep the Crashsim protocol at the integration boundary — Must Have

WHEN Crashsim HTTP responses or stream messages enter the operator
THE SYSTEM SHALL validate and translate them into the small internal event and snapshot shapes used by this feature
SO THAT engine-specific payload handling stays in the Crashsim integration code without introducing a generic game-provider contract.

### FR-008: Provide a minimal integration debug client — Must Have

WHEN an operator maintainer opens the local debug client
THE SYSTEM SHALL display the operator's connection state, current round snapshot, and received live events
SO THAT the complete event relay can be inspected during development.

## Non-Functional Requirements

### NFR-001: Security

- The engine operator key and webhook secret remain server-side.
- Invalid upstream event payloads are rejected and logged without logging secrets.
- Client stream access requires an authenticated operator player context before public deployment.

### NFR-002: Reliability

- Reconnect attempts use bounded backoff and do not create one upstream connection per client.
- The engine stream has no historical replay; the operator must not claim it recovered missed events. A snapshot restores current round state only.
- The implementation must be verifiable with the `DROP_WS_EVERY` and `REORDER` engine fault flags.

### NFR-003: Observability

- Log stream connection state changes, synchronization completion, and detected sequence gaps.
- Never log operator keys, webhook secrets, or raw authentication tokens.

### NFR-004: Debug client boundary

- The initial client is for local development and integration verification; it must not be exposed publicly before player authentication is implemented.
- Keep the event display bounded so a long-running debug session does not accumulate an unbounded browser log.

## Out of Scope

- Supporting additional games or engines, generic game-provider ports, a provider catalog, or a registry/plugin mechanism.
- Player registration, login, and full authorization implementation.
- Wallet ledger and debit/credit webhook processing, including duplicate `txId` handling.
- Bet placement and cashout commands, including unknown cashout outcomes.
- Full player gameplay UI, including bet and cashout controls, multi-instance event fan-out, and durable event replay.

## Decisions

### D-001: Player experience during an upstream outage

**Decision:** Freeze the last known game state, display a reconnecting indicator, and disable bets/cashouts until resynchronization completes.
**Reason:** A stale multiplier must not look live or be used for a money-affecting action.
**Source:** User answer to Q-001.
**Impacts:** US-002, FR-006, NFR-002.

### D-002: Single-engine scope for the first delivery

**Decision:** Implement only the Crashsim communication and downstream relay. Do not create generic game/provider extension points or organize the code for easy addition of other games.
**Reason:** This assessment delivery has one game and should keep the module direct and small. Another game, if required later, can trigger an explicit architecture decision based on its real needs.
**Source:** User direction.
**Impacts:** FR-007, Out of Scope.

### D-003: Upstream connection ownership

**Decision:** Keep one upstream engine stream connection per operator process and fan out downstream to clients.
**Reason:** Browsers must not connect directly to the engine, and each browser must not create a new upstream socket.
**Source:** `ASSESSMENT.md`.
**Impacts:** US-001, FR-001, FR-002.

### D-004: Include a minimal debug client in the first delivery

**Decision:** Include a plain browser debug client that displays connection status, the current snapshot, and received event messages. Defer player gameplay controls and styling.
**Reason:** It verifies the end-to-end stream in a browser without expanding this delivery into the player game UI.
**Source:** User direction.
**Impacts:** US-003, FR-008, NFR-004.

## Questions

### Q-001: Player behavior while the engine stream is unavailable

**Status:** answered
**Answer:** Freeze the last known state, show a reconnecting indicator, and disable bets/cashouts until synchronization completes.
**Decision:** D-001.

## Glossary

- **Operator:** Server-side service between player clients and the Crashsim engine.
- **Crashsim engine client:** Code that communicates with the Crashsim HTTP and WebSocket APIs and translates their payloads for the operator.
- **Snapshot:** Authoritative current-round state returned by the engine, including its current `seq`.
