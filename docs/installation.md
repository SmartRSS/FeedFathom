---
layout: default
title: Installation
nav_order: 2
---

# Installation Guide

## Prerequisites

Before installing FeedFathom, ensure you have:

1. **Bun** installed on your system ([Install Bun](https://bun.sh))
2. **Git** for cloning the repository
3. **Docker** (optional but recommended)

## Basic Installation

1. Clone the repository:
```bash
git clone https://github.com/SmartRSS/FeedFathom.git
```

2. Navigate to the project directory:
```bash
cd FeedFathom
```

3. Install dependencies:
```bash
bun install --frozen-lockfile
```

## Environment Setup

FeedFathom uses several environment variables for configuration:

### Core Configuration
- `ENABLE_REGISTRATION`: Enable new user registrations (default: false)
- `ALLOWED_EMAILS`: Comma-separated list of emails allowed to register

### Worker Configuration
- `WORKER_CONCURRENCY`: Number of concurrent jobs (default: 25)
- `LOCK_DURATION`: Lock duration in seconds for jobs (default: 60)
- `CLEANUP_INTERVAL`: Interval in seconds between cleanup jobs (default: 60)
- `GATHER_JOBS_INTERVAL`: Interval in seconds between job gathering cycles (default: 20)

### Scaling Configuration
- `WORKER_REPLICAS`: Number of worker instances to run (default: 3)

[Next: Running the Application](./running.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 } 