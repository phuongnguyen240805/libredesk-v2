-- name: get-all-context-links
SELECT
    id,
    created_at,
    updated_at,
    name,
    url_template,
    signing_secret,
    token_expiry_seconds,
    is_active
FROM
    context_links
ORDER BY created_at DESC;

-- name: get-context-link
SELECT
    id,
    created_at,
    updated_at,
    name,
    url_template,
    signing_secret,
    token_expiry_seconds,
    is_active
FROM
    context_links
WHERE
    id = $1;

-- name: get-context-link-signing-secret
SELECT
    signing_secret
FROM
    context_links
WHERE
    id = $1;

-- name: get-active-context-links
SELECT
    id,
    created_at,
    updated_at,
    name,
    url_template,
    token_expiry_seconds,
    is_active
FROM
    context_links
WHERE
    is_active = true
ORDER BY created_at DESC;

-- name: insert-context-link
INSERT INTO
    context_links (name, url_template, signing_secret, token_expiry_seconds, is_active)
VALUES
    ($1, $2, $3, $4, $5)
RETURNING *;

-- name: update-context-link
UPDATE
    context_links
SET
    name = $2,
    url_template = $3,
    signing_secret = $4,
    token_expiry_seconds = $5,
    is_active = $6,
    updated_at = NOW()
WHERE
    id = $1
RETURNING *;

-- name: delete-context-link
DELETE FROM
    context_links
WHERE
    id = $1;

-- name: toggle-context-link
UPDATE
    context_links
SET
    is_active = NOT is_active,
    updated_at = NOW()
WHERE
    id = $1
RETURNING *;
