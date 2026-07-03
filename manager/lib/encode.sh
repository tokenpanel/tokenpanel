#!/usr/bin/env bash
# URI-encoding helpers for safely embedding credentials in MongoDB connection
# URIs. A password containing @, :, /, +, #, etc. would break the URI without
# percent-encoding. jq is already a manager dependency (backup size checks); we
# fall back to python3, then a sed-based encoder for the common problematic
# characters.

uri_encode() {
  local val="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -nr --arg v "$val" '$v|@uri'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$val"
  else
    # Fallback: encode the characters most likely to appear in credentials and
    # break a URI. Not exhaustive but covers @ : / + # ? & = and space.
    printf '%s' "$val" | sed \
      -e 's/%/%25/g' \
      -e 's/ /%20/g' \
      -e 's/@/%40/g' \
      -e 's/:/%3A/g' \
      -e 's|/|%2F|g' \
      -e 's/+/%2B/g' \
      -e 's/#/%23/g' \
      -e 's/?/%3F/g' \
      -e 's/&/%26/g' \
      -e 's/=/%3D/g'
  fi
}
