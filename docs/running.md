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
bun run build
```

This compiles TypeScript files and generates output in the `dist` directory.

[Next: Browser Extensions](./extensions.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 } 