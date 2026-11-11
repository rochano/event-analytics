# Builds one of the Go services: --build-arg CMD=collector | queryapi | seed
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG CMD=collector
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/${CMD} && mkdir -p /out/data/spool

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/app /app/app
# The spool directory must be writable by the nonroot user (uid 65532);
# a named volume mounted here inherits this ownership.
COPY --from=build --chown=65532:65532 /out/data /data
COPY web /app/web
COPY sdk/js /app/sdk
ENV WEB_DIR=/app/web SDK_DIR=/app/sdk
USER nonroot
ENTRYPOINT ["/app/app"]
