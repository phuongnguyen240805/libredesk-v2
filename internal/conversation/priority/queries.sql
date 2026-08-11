-- name: get-all
SELECT created_at, id, name from conversation_priorities;

-- name: get
SELECT created_at, id, name from conversation_priorities WHERE id = $1;