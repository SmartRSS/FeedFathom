# FeedFathom

FeedFathom is an efficient RSS feed reader paired with an extension intended for use with both Firefox and Chromium-based browsers.

---

## Table of Contents

- [Introduction to the Technology Stack](#introduction-to-the-technology-stack)
- [Installation](#installation)
- [Project Components](#project-components)
- [Building the Project](#building-the-project)
- [Running the Development Server](#running-the-development-server)
- [Running a Production Build](#running-a-production-build)
- [Packing the Extension](#packing-the-extension)
- [Usage](#usage)
    - [Firefox](#firefox)
    - [Chromium](#chromium)
- [Extension Features](#extension-features)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Introduction to the Technology Stack

FeedFathom is built on a modern stack of powerful tools to deliver speed and flexibility:

- **SvelteKit**: A highly efficient and modern framework for building web interfaces and server-side APIs.
- **Bun**: A fast JavaScript runtime (like Node.js), chosen for its speed and capability in handling dependencies, building, and running server logic.
- **Docker (optional)**: Used to simplify deploys and local development.
- **Background Workers**: For managing scheduled RSS feed updates.
- **SMTP Server**: For handling unique email addresses used for newsletters.

This approach ensures top performance and flexibility, catering to both development and deployment needs.

---

## Installation

To get started with FeedFathom, you need to have **Bun** installed on your system. Follow the instructions on the [Bun official website](https://bun.sh) to install it.

Once Bun is installed, clone the repository and install the dependencies:

```bash
git clone https://github.com/SmartRSS/FeedFathom.git
cd FeedFathom
bun install --frozen-lockfile
```

---

## Project Components

FeedFathom consists of several key components:

- **SvelteKit Frontend and API**: Provides a simple and effective interface for managing feeds and subscriptions.
- **Worker**: Handles background tasks, such as updating and fetching RSS feeds at scheduled intervals.
- **SMTP Server**: Allows the generation and handling of unique email addresses for subscribing to newsletters.

---

## Building the Project

To build the project, run the following command:

```bash
bun run build
```

This command compiles the TypeScript files and generates the necessary output in the `dist` directory.

---

## Running the Development Server

To run the project locally, you must ensure that Docker is installed. You can download Docker from the [official Docker website](https://www.docker.com/).
```bash
bun run dev
````

This command requires Docker to be running, as it handles the environment setup for the development server. Without Docker, it is not possible to run the development server using the provided commands.

> **Note**: While it is theoretically possible to run the project without Docker, no commands for such a setup are provided in this repository, and support for manual setups may require additional effort.

---

## Running a Production Build

To run the production version of the project, use Docker Compose to start the necessary services and the application:

```bash
docker compose up -d
```

This command will start the application in production mode along with any required additional services. By default, registration is disabled for security reasons, with two exceptions:

1. The first account can always be created regardless of the registration setting
2. When `ENABLE_REGISTRATION` is set to `true`

After creating the first account, it's recommended to keep registration disabled unless you intend to make the instance public or have other security measures in place.

> **Note**: While it is technically possible to run the project without Docker, no ready-to-use commands are provided. To run the project manually, you would need to set up the required environment, which includes services like **Redis** and **Postgres**, and configure the necessary **environment variables** for the application to function correctly. Refer to the official [Redis Documentation](https://redis.io/) and [Postgres Documentation](https://www.postgresql.org/) for help.

## Environment Variables

FeedFathom supports the following environment variables for configuration:

### Core Configuration
- `ENABLE_REGISTRATION`: Enable new user registrations (default: false). Note: The first account can always be created regardless of this setting
- `ALLOWED_EMAILS`: Comma-separated list of emails allowed to register (optional, if empty all emails are allowed)

### Worker Configuration
- `WORKER_CONCURRENCY`: Number of concurrent jobs (default: 25)
- `LOCK_DURATION`: Lock duration in seconds for jobs (default: 60)
- `CLEANUP_INTERVAL`: Interval in seconds between cleanup jobs (default: 60)
- `GATHER_JOBS_INTERVAL`: Interval in seconds between job gathering cycles (default: 20)

### Scaling Configuration
- `WORKER_REPLICAS`: Number of worker instances to run (default: 3)


> **Note**: When running with Docker Compose, database and Redis connection settings are automatically configured. If running without Docker, you'll need to set up these services separately and configure their connection details.

---

## Packing the Extension

To prepare the browser extensions for Firefox and Chromium, run:

```bash
bun run pack
```

This will create two zip files in the `dist` directory:

- `FeedFathom_ff.zip` for Firefox.
- `FeedFathom_ch.zip` for Chromium.

---

## Usage

After packing the extension, you can load it into your browser as follows:

### Firefox

1. Open Firefox and navigate to `about:debugging`.
2. Click on `This Firefox` in the sidebar.
3. Click `Load Temporary Add-on`.
4. Select the `FeedFathom_ff.zip` file.

### Chromium

1. Open your Chromium-based browser (like Chrome or Edge).
2. Navigate to `chrome://extensions/`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the `dist_chromium` directory.

---

## Extension Features

The FeedFathom extensions provide the following functionalities:

- **Feed Detection**: Automatically detects RSS feeds on the current website. If an API instance isn't configured, the extension copies the feed address for easy management.
- **Subscription Form**: If a FeedFathom API instance is set, the extension automatically opens the subscription form for streamlined feed management.
- **Unique Email Address Generation**: Provides the option to generate unique email addresses used to subscribe to newsletters. These are processed by the integrated SMTP server, ensuring email subscriptions stay organized and secure.

> **What is an API Instance?**
> FeedFathom uses a personalized server API to manage user subscriptions and feeds. If this is not configured, the workflow defaults to only detecting and copying RSS addresses.

---

## Troubleshooting

Here are some common issues and how to resolve them:

1. **Bun Command Not Recognized**:
    - Ensure you've installed Bun correctly and added it to your system PATH. Refer to the [Bun installation guide](https://bun.sh).
2. **Docker Issues**:
    - Confirm Docker is installed and running. If you encounter errors, try restarting Docker or consult [Docker's troubleshooting guide](https://docs.docker.com/get-docker/).
3. **Extensions Not Loading**:
    - Make sure you're using the appropriate browser and loading the correct zip file (`FeedFathom_ff.zip` for Firefox and `FeedFathom_ch.zip` for Chromium).

---

## Contributing

FeedFathom is an open-source project, and contributions are highly encouraged. Here's how you can contribute:

1. Fork the repository.
2. Create a new branch:
   ```bash
   git checkout -b feature-branch-name
   ```
3. Implement your changes and commit them:
   ```bash
   git commit -m 'Add feature'
   ```
4. Push your branch:
   ```bash
   git push origin feature-branch-name
   ```
5. Create a pull request and briefly explain your changes.

When contributing, please ensure your code:
- Follows the existing project style.
- Includes tests, if applicable.

---

## License

This project is licensed under the MIT License.

---

## Acknowledgements

This project uses the following libraries and tools:

- [Remix Icon](https://remixicon.com/) - Distributed under the Apache License 2.0.
- [Bun](https://bun.sh) - JavaScript runtime.
- [SvelteKit](https://kit.svelte.dev/) - Web framework.
