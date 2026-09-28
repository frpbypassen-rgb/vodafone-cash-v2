# Isolated Cloud Development

These scripts are for a disposable, dedicated Linux development machine only.
They must never be run on production or Staging. Installation requires explicit
process environment settings `CLOUD_AGENT_DEV_SETUP_ENABLED=true` and
`NODE_ENV=development` before `install.sh` is invoked. Installation changes
development-machine system packages; it is not a deployment command.

The generated environment uses MongoDB on loopback port 27019, replica set
`clouddev`, database `ahram_cloud_agent_dev`, and HTTP port 3101. No production
environment is copied. MongoDB files and logs stay under `.cloud-dev-data/` in
the checkout. Startup and seeding reject every other database target before
connecting or creating database files.

Seeded credentials, balances, and relaxed device controls are synthetic and
development-only. The seed must not be used to bootstrap real accounts. All
four external worker switches and WhatsApp OTP are explicitly disabled.
Financial release approval, migrations, and production actions remain separate.
