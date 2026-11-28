variable "IMAGE_PREFIX" {
  default = "ghcr.io/smartrss/feedfathom"
}

variable "FEEDFATHOM_TAG" {
  default = "local"
}

variable "FEEDFATHOM_BUILD" {
  default = ""
}

variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}

group "default" {
  targets = ["feedfathom-server", "feedfathom-worker", "feedfathom-migrator"]
}

target "_common" {
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    FEEDFATHOM_BUILD = FEEDFATHOM_BUILD
  }
  platforms = split(",", PLATFORMS)
}

target "feedfathom-server" {
  inherits = ["_common"]
  target   = "feedfathom-server"
  tags     = ["${IMAGE_PREFIX}/feedfathom-server:${FEEDFATHOM_TAG}"]
}

target "feedfathom-worker" {
  inherits = ["_common"]
  target   = "feedfathom-worker"
  tags     = ["${IMAGE_PREFIX}/feedfathom-worker:${FEEDFATHOM_TAG}"]
}

target "feedfathom-migrator" {
  inherits = ["_common"]
  target   = "feedfathom-migrator"
  tags     = ["${IMAGE_PREFIX}/feedfathom-migrator:${FEEDFATHOM_TAG}"]
}
