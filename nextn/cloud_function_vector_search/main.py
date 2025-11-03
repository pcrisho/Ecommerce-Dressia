import os
import json
import logging
import math
from typing import List, Dict, Any, Optional

from google.cloud import aiplatform_v1 as aiplatform

# --- Configuration (override with environment variables) ---
API_ENDPOINT = os.getenv(
    "API_ENDPOINT",
    "686659988.us-east1.847479956619.vdb.vertexai.goog",
)
INDEX_ENDPOINT_RESOURCE = os.getenv(
    "INDEX_ENDPOINT_RESOURCE",
    "projects/847479956619/locations/us-east1/indexEndpoints/2877628638075813888",
)
DEPLOYED_INDEX_ID = os.getenv("DEPLOYED_INDEX_ID", "Blusas-Vestidos-Index-Final")
DEFAULT_NEIGHBOR_COUNT = int(os.getenv("DEFAULT_NEIGHBOR_COUNT", "10"))

logger = logging.getLogger("vector_search_function")
logging.basicConfig(level=logging.INFO)


def _l2_normalize(vec: List[float]) -> List[float]:
    norm = math.sqrt(sum((float(x) ** 2 for x in vec)))
    if norm == 0 or math.isnan(norm):
        return vec
    return [float(x) / norm for x in vec]


def find_similar_products(feature_vector: List[float], neighbor_count: int = DEFAULT_NEIGHBOR_COUNT, normalize: bool = False) -> List[Dict[str, Any]]:
    """Query Vertex AI MatchService (Vector Search) and return list of neighbors.

    Returns list of dicts: [{"id": ..., "distance": ...}, ...]
    """
    if normalize:
        feature_vector = _l2_normalize(feature_vector)

    client = aiplatform.MatchServiceClient(client_options={"api_endpoint": API_ENDPOINT})

    # Build query datapoint
    datapoint = aiplatform.IndexDatapoint(feature_vector=feature_vector)
    query = aiplatform.FindNeighborsRequest.Query(
        datapoint=datapoint,
        neighbor_count=int(neighbor_count),
    )

    request = aiplatform.FindNeighborsRequest(
        index_endpoint=INDEX_ENDPOINT_RESOURCE,
        deployed_index_id=DEPLOYED_INDEX_ID,
        queries=[query],
        return_full_datapoint=False,
    )

    response = client.find_neighbors(request=request)

    results: List[Dict[str, Any]] = []
    # response.nearest_neighbors is a Sequence of FindNeighborsResponse.NearestNeighbors
    if not response.nearest_neighbors:
        return results

    neighbors = response.nearest_neighbors[0].neighbors
    for neighbor in neighbors:
        # neighbor may contain `id` and optional `distance` fields depending on API
        neigh_id = getattr(neighbor, "id", None)
        distance = getattr(neighbor, "distance", None)
        # Some API versions may expose `distance_micros` or similar; attempt best-effort
        if neigh_id is None:
            continue
        entry: Dict[str, Any] = {"id": str(neigh_id)}
        if distance is not None:
            entry["distance"] = float(distance)
        results.append(entry)

    return results


def http_vector_search(request):
    """HTTP Cloud Function entrypoint.

    Expects JSON body: {"feature_vector": [float,...], "neighbor_count": 10, "normalize": false}
    Returns JSON: {"results": [{"id":..., "distance":...}, ...]}
    """
    # Enable CORS preflight
    if request.method == "OPTIONS":
        # Allows GET, POST, OPTIONS
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        }
        return ("", 204, headers)

    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    }

    try:
        request_json = request.get_json(silent=True)
        if not request_json:
            logger.error("No JSON payload received")
            return (json.dumps({"error": "Request body must be JSON"}), 400, headers)

        feature_vector = request_json.get("feature_vector")
        if feature_vector is None:
            return (json.dumps({"error": "Missing 'feature_vector' in request body"}), 400, headers)

        if not isinstance(feature_vector, list):
            return (json.dumps({"error": "'feature_vector' must be a list of numbers"}), 400, headers)

        if len(feature_vector) != 1408:
            return (
                json.dumps({"error": "'feature_vector' must have length 1408"}),
                400,
                headers,
            )

        neighbor_count = int(request_json.get("neighbor_count", DEFAULT_NEIGHBOR_COUNT))
        normalize = bool(request_json.get("normalize", False))

        logger.info("Running vector search: neighbor_count=%s normalize=%s", neighbor_count, normalize)
        results = find_similar_products(feature_vector, neighbor_count=neighbor_count, normalize=normalize)

        return (json.dumps({"results": results}), 200, headers)

    except Exception as exc:
        logger.exception("Error during vector search")
        return (
            json.dumps({"error": "Internal server error", "detail": str(exc)}),
            500,
            headers,
        )


# If running locally with functions-framework, entrypoint name is `http_vector_search`.
