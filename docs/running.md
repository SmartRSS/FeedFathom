---
layout: default
title: Running the Application
nav_order: 3
---

# Running FeedFathom

## Development Server

To run the development server:

```bash
bun run dev
```

This requires Docker to be running as it handles the environment setup.

## Production Deployment

For production deployment using Docker:

```bash
docker compose up -d
```

This command starts the application and all required services in production mode. By default, registration is disabled for security reasons, with two exceptions:

1. The first account can always be created regardless of the registration setting
2. When `ENABLE_REGISTRATION` is set to `true`

After creating the first account, it's recommended to keep registration disabled unless you intend to make the instance public or have other security measures in place.

## Building the Project

To build the project:

```bash
bun run build-project
```

This compiles TypeScript files and generates output in the `build` directory.

The build process consists of three parts that can be run individually:

```bash
# Build the server component
bun run build-server

# Build the worker component
bun run build-worker

# Build the browser extensions
bun run build-extension
```

## Development Workflow

For development, you can use watch commands that automatically rebuild on file changes:

```bash
# Watch and rebuild the server
bun run watch-server

# Watch and rebuild the worker
bun run watch-worker
```

## Code Quality and Linting

FeedFathom uses several tools to maintain code quality:

```bash
# Run all lint checks
bun run lint

# Fix linting issues where possible
bun run lint:fix

# Format code using Biome
bun run format

# Run ESLint only
bun run eslint

# Fix ESLint issues
bun run eslint:fix

# Run Svelte type checking
bun run svelte-check
```

[Next: Browser Extensions](./extensions.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
