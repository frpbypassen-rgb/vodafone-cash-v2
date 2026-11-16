# Transfer guard failure classification

The agent portal displayed `TRANSFER_COOLDOWN_LOCK_TIMEOUT` with a fixed two-second wait for every distributed-lock error. A Redis write failure therefore looked like an existing transfer even when no competing request existed. The old wrapper also ignored caller retry settings and listened to `clientError`, although Redlock v5 reports errors through `error`.

Lock acquisition now distinguishes verified resource contention (`LOCK_BUSY`) from infrastructure failure (`LOCK_UNAVAILABLE`). The transfer endpoint returns HTTP 429 with the remaining Redis lock TTL for actual contention, or HTTP 503 / `TRANSFER_GUARD_UNAVAILABLE` when protection is unavailable. Both fail before transfer creation and wallet debit. Existing recipient/amount cooldown windows remain unchanged. No automatic payment retry is introduced.

Actual contention cannot fall back to an independent memory lock. Production initialization failure remains closed. Local memory-lock ownership is checked on release so an expired holder cannot unlock a newer holder.

Regression coverage includes real Redis and Redlock: concurrent acquisition, TTL reporting, release/reuse, write rejection while PING still succeeds, and recovery after the isolated write restriction is removed. The Redis integration test launches its own loopback server with persistence disabled, touches no production service, and can be run with `node --test tests/transferCooldownRedis.integration.cjs`; set `REDIS_TEST_BINARY` when Redis is installed elsewhere.

Production inspection on 2026-11-16 confirmed repeated `ECONNREFUSED 127.0.0.1:6379`, including BullMQ workers, and a closed Redis connection. The old cache client permanently stopped reconnecting after three failures; its historical `isRedisAvailable` flag still reported connected to readiness.

The existing Windows `Redis` service was stopped, startup mode `Disabled`, with exit code 1077 and no configured recovery actions. Operational recovery enabled automatic startup and restart actions after 5, 15 and 60 seconds, then started that existing service. No queue flush, new Redis instance, transaction status change or balance adjustment was performed.

After an established connection, Redis now keeps reconnecting with a capped backoff. Initial startup retains its finite retry budget. Live client state and a bounded PING drive readiness; an unavailable required Redis returns HTTP 503 and reports that mutations are unavailable. Integration coverage stops and restarts an isolated real Redis server and verifies automatic client recovery without restarting the application.

A successful PING alone does not establish that Redis permits writes. The lock path still fails closed and distinguishes write failures from contention.

Validation: 104 focused tests in nine suites and three isolated real-Redis integration tests passed, as did ESLint, TypeScript and architecture checks. The attempted full repository run is not green in this workstation: native canvas fixture path checks and a missing Puppeteer browser failed, and the serial VM run exhausted its heap. These unrelated environment failures were not bypassed or weakened.
