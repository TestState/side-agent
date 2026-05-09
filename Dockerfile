# Stage 1: Build
FROM node:22-slim AS build
WORKDIR /workspace

# Copy specification for proto generation
COPY specification /specification

# Build shared library
COPY implementation/client/teststate-client-node /workspace/teststate-client-node
WORKDIR /workspace/teststate-client-node
RUN npm install && npm run build

# Build side-agent
WORKDIR /workspace/side-agent
COPY implementation/client/side-agent /workspace/side-agent
RUN npm install && npm run build

# Stage 2: Runtime
FROM node:22-slim
WORKDIR /app

# Copy built library and agent
COPY --from=build /workspace/teststate-client-node /app/teststate-client-node
COPY --from=build /workspace/side-agent /app/side-agent

WORKDIR /app/side-agent

# Default environment variables
ENV HUB_URL=http://cms:9000
ENV CLIENT_NAME=DockerSideAgent
ENV SELENIUM_REMOTE_URL=http://selenium-hub:4444/wd/hub

# Run the compiled JavaScript directly with Node
CMD ["node", "dist/index.js"]
