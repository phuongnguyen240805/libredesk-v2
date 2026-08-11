-- name: get-all-activities
SELECT
    COUNT(*) OVER() as total,
    id, 
    created_at, 
    updated_at, 
    activity_type, 
    activity_description, 
    actor_id, 
    target_model_type, 
    target_model_id, 
    ip
FROM 
    activity_logs WHERE 1=1 

-- name: insert-activity
INSERT INTO activity_logs (
    activity_type, 
    activity_description, 
    actor_id, 
    target_model_type, 
    target_model_id, 
    ip
) VALUES (
    $1, $2, $3, $4, $5, $6
);