#!/usr/bin/env python3
"""Read-only admission for an existing, protected Metrics Worker deployment."""

import json
import os
import re
import sys
import urllib.error
import urllib.request


class AdmissionError(Exception):
    """Contains only fixed diagnostics, never configuration or secret values."""


WORKER_SECRET_KEYS = (
    "SUPABASE_URL",
    "SB_SECRET_KEY",
    "OBS_AQIDB_SUPABASE_URL",
    "OBS_AQIDB_SECRET_KEY",
    "CFLARE_R2_ENDPOINT",
    "CFLARE_R2_BUCKET",
    "CFLARE_R2_REGION",
    "CFLARE_R2_ACCESS_KEY_ID",
    "CFLARE_R2_SECRET_ACCESS_KEY",
    "UK_AQ_R2_HISTORY_VERSION",
    "UK_AQ_DB_SIZE_API_TOKEN",
)


def require(condition, message):
    if not condition:
        raise AdmissionError(message)


def required(env, key):
    value = env.get(key, "")
    require(isinstance(value, str) and bool(value.strip()), "Missing " + key + ".")
    require(value == value.strip(), "Surrounding whitespace in " + key + ".")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON field in Cloudflare metadata.")
        result[key] = value
    return result


def validate_local(env):
    environment = required(env, "UK_AQ_ENV_NAME")
    require(environment in {"TEST", "LIVE"}, "Target environment must be TEST or LIVE.")
    repository = required(env, "GITHUB_REPOSITORY")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
            "Invalid running repository identity.")
    require(required(env, "UK_AQ_GITHUB_REPO") == repository,
            "Configured repository disagrees with the running repository.")

    account = required(env, "UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID")
    worker = required(env, "UK_AQ_DB_R2_METRICS_API_WORKER_NAME")
    require(re.fullmatch(r"[a-f0-9]{32}", account), "Invalid Cloudflare account identifier.")
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", worker), "Invalid Worker name.")

    token = required(env, "CLOUDFLARE_API_TOKEN")
    require(not any(character.isspace() for character in token),
            "Invalid Cloudflare credential format.")
    # Check the complete upload payload before the first remote mutation.
    # In particular, the application treats an absent API token as public access.
    for key in WORKER_SECRET_KEYS:
        required(env, key)
    require(env["UK_AQ_R2_HISTORY_VERSION"] in {"v1", "v2", "v3"},
            "History version must be v1, v2, or v3.")
    return environment, repository, account, worker, token


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        # Never forward the bearer credential to a redirect destination.
        raise AdmissionError("Cloudflare metadata redirects are not permitted.")


def validate_existing_bindings(account, worker, token):
    # This endpoint returns only secret names/types, never secret values.
    # Query the exact configured account/script pair; ownership is operator-verified.
    url = ("https://api.cloudflare.com/client/v4/accounts/" + account
           + "/workers/scripts/" + worker + "/secrets")
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
    }, method="GET")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            require(response.status == 200, "Cloudflare metadata request did not succeed.")
            body = response.read(131073)
        require(len(body) <= 131072, "Cloudflare metadata response is too large.")
        metadata = json.loads(body, object_pairs_hook=unique_object)
    except urllib.error.HTTPError as error:
        # Do not print response bodies, URLs, headers or exception text.
        raise AdmissionError("Existing Worker secret metadata unavailable (HTTP "
                             + str(error.code) + ").") from None
    except (OSError, ValueError, RecursionError):
        raise AdmissionError("Cloudflare metadata request or response failed.") from None
    require(isinstance(metadata, dict) and metadata.get("success") is True,
            "Cloudflare did not confirm metadata access.")
    bindings = metadata.get("result")
    require(isinstance(bindings, list) and all(isinstance(item, dict) for item in bindings),
            "Cloudflare secret metadata has an unexpected shape.")
    names = [item.get("name") for item in bindings]
    require(all(isinstance(name, str) for name in names) and len(set(names)) == len(names),
            "Cloudflare secret metadata has invalid or duplicate names.")
    secret_names = {item["name"] for item in bindings if item.get("type") == "secret_text"}
    missing = sorted(set(WORKER_SECRET_KEYS) - secret_names)
    require(not missing, "Existing Worker lacks required secret bindings: " + ", ".join(missing))


def main():
    try:
        environment, repository, account, worker, token = validate_local(os.environ)
        validate_existing_bindings(account, worker, token)
    except AdmissionError as error:
        print("Metrics deployment refused: " + str(error), file=sys.stderr)
        return 1
    print("Existing Metrics target admitted:")
    print("  target_env=" + environment)
    print("  repository=" + repository)
    print("  worker_name=" + worker)
    print("  account_id=" + account[:4] + "..." + account[-4:])
    print("  r2_history_version=" + os.environ["UK_AQ_R2_HISTORY_VERSION"])
    print("  required_secret_bindings=present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
