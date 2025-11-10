import os
import json
import logging
import uuid
from datetime import datetime
from flask import Flask, request
from google.api_core import exceptions as gcp_exceptions
from google.cloud import aiplatform_v1

# --- CONFIGURACIÓN ---
INDEX_ENDPOINT_RESOURCE = os.environ.get("INDEX_ENDPOINT_RESOURCE")
DEPLOYED_INDEX_ID = os.environ.get("DEPLOYED_INDEX_ID")
API_ENDPOINT = os.environ.get("API_ENDPOINT", "us-east1-aiplatform.googleapis.com")
EXPECTED_DIMENSIONS = int(os.environ.get("EXPECTED_DIMENSIONS", 1408))
MAX_NEIGHBORS = int(os.environ.get("MAX_NEIGHBORS", 20))
SIMILARITY_THRESHOLD = float(os.environ.get("IMAGE_MATCH_SIMILARITY_THRESHOLD", 0.0))
RETURN_FULL_DATAPOINT = os.environ.get("RETURN_FULL_DATAPOINT", "true").lower() in ("1", "true", "yes")

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# --- CLIENTE GLOBAL ---
_vector_search_client = None


def get_vector_search_client():
    """Inicializa el cliente de MatchService solo una vez."""
    global _vector_search_client
    if _vector_search_client is None:
        try:
            logging.info(f"🔧 Inicializando MatchServiceClient con endpoint: {API_ENDPOINT}")
            _vector_search_client = aiplatform_v1.MatchServiceClient(
                client_options={"api_endpoint": API_ENDPOINT}
            )
        except Exception as e:
            logging.exception(f"FATAL: No se pudo inicializar el cliente de Vertex AI: {e}")
            raise
    return _vector_search_client


def normalize_similarity(distance: float) -> float:
    """Convierte una distancia o score arbitrario en una similitud normalizada [0..1].

    Nota: asumimos que `distance` sigue la semántica de Vertex (lower = more similar).
    """
    if distance is None:
        return 0.0
    try:
        return 1 / (1 + abs(distance))
    except Exception:
        return 0.0


def _extract_metadata_from_datapoint(datapoint) -> dict:
    """Extrae metadata útil desde un Vertex IndexDatapoint/Datapoint objeto.

    Retorna un dict con keys comunes: filename, gcs_uri, url, product_id, color, etc.
    """
    out = {}
    try:
        # datapoint.metadata puede ser un Mapping de strings a bytes/values
        raw_meta = getattr(datapoint, "metadata", None)
        if raw_meta:
            # Convertir a dict simple
            try:
                # Algunos clientes exponen un Mapping[str,str] directamente
                out.update({k: v for k, v in raw_meta.items()})
            except Exception:
                # Fallback, si no es iterable
                pass

        # Some datapoints include `restricts` or `data` nested structures
        # Try common keys if not already extracted
        for k in ("gcs_uri", "gs_uri", "uri", "image_url", "url", "filename", "file", "path"):
            if not out.get(k) and raw_meta and raw_meta.get(k):
                out[k] = raw_meta.get(k)

        # Normalize common product id keys
        for pid_key in ("productId", "product_id", "productid"):
            if not out.get("product_id") and raw_meta and raw_meta.get(pid_key):
                out["product_id"] = raw_meta.get(pid_key)

        # Color info if present
        if raw_meta and raw_meta.get("color_info"):
            ci = raw_meta.get("color_info")
            out["color_info"] = ci
        else:
            # flat color fields
            if raw_meta and raw_meta.get("color"):
                out["color"] = raw_meta.get("color")
            if raw_meta and raw_meta.get("color_confidence"):
                out["color_confidence"] = raw_meta.get("color_confidence")
    except Exception:
        logging.debug("No se pudo extraer metadata completa del datapoint", exc_info=True)
    return out


def _gs_to_https(gs_uri: str) -> str:
    if not gs_uri:
        return None
    if isinstance(gs_uri, bytes):
        try:
            gs_uri = gs_uri.decode("utf-8")
        except Exception:
            gs_uri = str(gs_uri)
    if not isinstance(gs_uri, str):
        return None
    if gs_uri.startswith("gs://"):
        parts = gs_uri[5:].split("/", 1)
        if len(parts) == 2:
            return f"https://storage.googleapis.com/{parts[0]}/{parts[1]}"
    return gs_uri


def vector_search_proxy(req):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
    }

    if req.method == "OPTIONS":
        headers["Access-Control-Allow-Methods"] = "POST"
        headers["Access-Control-Allow-Headers"] = "Content-Type"
        return ("", 204, headers)

    request_json = req.get_json(silent=True)
    feature_vector = request_json.get("feature_vector") if request_json else None
    neighbor_count = int(request_json.get("neighbor_count", 10)) if request_json else 10
    input_color = request_json.get("color")  # opcional

    request_id = str(uuid.uuid4())
    logging.info(f"📩 [req:{request_id}] Petición recibida. feature_vector dims={len(feature_vector) if feature_vector else 0}, neighbor_count={neighbor_count}")

    if not feature_vector or len(feature_vector) != EXPECTED_DIMENSIONS:
        msg = f"Vector inválido. Longitud esperada: {EXPECTED_DIMENSIONS}"
        logging.warning(f"⚠️ [req:{request_id}] {msg}")
        return (json.dumps({"error": msg, "requestId": request_id}), 400, headers)

    neighbor_count = max(1, min(neighbor_count, MAX_NEIGHBORS))

    try:
        client = get_vector_search_client()

        # Log a head of the vector for diagnostics (not printing entire vector)
        try:
            head = feature_vector[:8]
            logging.debug(f"[req:{request_id}] feature_vector len={len(feature_vector)} head={head}")
        except Exception:
            pass

        datapoint = aiplatform_v1.IndexDatapoint(feature_vector=feature_vector)
        query = aiplatform_v1.FindNeighborsRequest.Query(
            datapoint=datapoint,
            neighbor_count=neighbor_count
        )

        logging.info(f"🔍 [req:{request_id}] Consultando endpoint: {INDEX_ENDPOINT_RESOURCE} deployed_index_id={DEPLOYED_INDEX_ID} return_full_datapoint={RETURN_FULL_DATAPOINT}")
        request_obj = aiplatform_v1.FindNeighborsRequest(
            index_endpoint=INDEX_ENDPOINT_RESOURCE,
            deployed_index_id=DEPLOYED_INDEX_ID,
            queries=[query],
            return_full_datapoint=RETURN_FULL_DATAPOINT,
        )

        response = client.find_neighbors(request=request_obj)
        logging.info(f"✅ [req:{request_id}] Consulta completada en Vertex AI.")

    except gcp_exceptions.PermissionDenied as e:
        logging.error(f"🚫 [req:{request_id}] Permiso denegado: {e}")
        return (json.dumps({"error": "Permiso denegado para Vertex AI. Verifique IAM.", "requestId": request_id}), 403, headers)

    except Exception as e:
        logging.exception(f"❌ [req:{request_id}] Error interno al consultar el índice: {e}")
        return (json.dumps({"error": f"Error interno al consultar el índice: {str(e)}", "requestId": request_id}), 500, headers)

    results = []
    total_before_filter = 0
    total_after_filter = 0

    try:
        nn_group = getattr(response, "nearest_neighbors", None)
        if not nn_group or len(nn_group) == 0:
            logging.warning(f"⚠️ [req:{request_id}] No se recibió nearest_neighbors en la respuesta de Vertex.")
            # Return empty but valid structure
            body = {
                "results": [],
                "topK": 0,
                "source": "vertex",
                "requestId": request_id,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "resultsBeforeFilter": 0,
                "resultsAfterFilter": 0
            }
            return (json.dumps(body), 200, headers)

        neighbors = nn_group[0].neighbors
    except Exception:
        logging.exception("No se pudieron leer neighbors de la respuesta de Vertex")
        neighbors = []

    for neighbor in neighbors:
        total_before_filter += 1

        # Vertex's neighbor.distance may be None or a float
        distance = getattr(neighbor, "distance", None)
        similarity = normalize_similarity(distance)

        metadata = {}
        try:
            dp = getattr(neighbor, "datapoint", None)
            if dp is not None:
                metadata = _extract_metadata_from_datapoint(dp) or {}
                # if datapoint has an id field
                dp_id = getattr(dp, "datapoint_id", None) or getattr(dp, "id", None)
            else:
                dp_id = getattr(neighbor, "datapoint_id", None) or getattr(neighbor, "id", None)
        except Exception:
            dp_id = getattr(neighbor, "datapoint_id", None) or getattr(neighbor, "id", None)

        # Apply optional color bias if input_color provided and metadata contains a color
        try:
            if input_color and metadata.get("color"):
                if str(metadata.get("color")).lower() != str(input_color).lower():
                    similarity = similarity * 0.8
        except Exception:
            pass

        # Only return items above threshold
        if similarity < SIMILARITY_THRESHOLD:
            continue

        total_after_filter += 1

        # Build user-friendly metadata fields
        filename = metadata.get("filename") or metadata.get("file") or None
        gcs_uri = metadata.get("gcs_uri") or metadata.get("gs_uri") or metadata.get("uri") or None
        image_url = _gs_to_https(gcs_uri) if gcs_uri else (metadata.get("image_url") or metadata.get("url") or None)

        # color info normalization
        color_info = None
        if metadata.get("color_info"):
            ci = metadata.get("color_info")
            # expect ci to be dict-like
            color_info = {
                "dominant_color": ci.get("dominant_color") if isinstance(ci, dict) else ci,
                "color_confidence": (ci.get("color_confidence") if isinstance(ci, dict) else None)
            }
        else:
            if metadata.get("color"):
                color_info = {"dominant_color": metadata.get("color"), "color_confidence": metadata.get("color_confidence")}

        results.append({
            "id": dp_id or getattr(neighbor, "datapoint_id", None) or getattr(neighbor, "id", None),
            "distance": distance,
            "similarity": similarity,
            "score": similarity,  # kept for compatibility (normalized)
            "similarity_score": similarity,
            "color_info": color_info,
            "metadata": {
                "filename": filename,
                "gcs_uri": gcs_uri,
                **({} if not metadata else metadata)
            },
            "image_url": image_url
        })

    # Orden descendente por similarity
    results.sort(key=lambda x: x.get("similarity", 0), reverse=True)

    response_body = {
        "results": results,
        "topK": len(results),
        "source": "vertex",
        "requestId": request_id,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "resultsBeforeFilter": total_before_filter,
        "resultsAfterFilter": total_after_filter
    }

    # Debug: include a small sample of the original Vertex response (avoid large payloads)
    try:
        response_body["_vertex_sample"] = {
            "nearest_neighbors_length": len(getattr(response, "nearest_neighbors", []))
        }
    except Exception:
        pass

    return (json.dumps(response_body, default=str), 200, headers)


# --- FLASK APP (para Cloud Run) ---
app = Flask(__name__)

@app.route("/", methods=["POST", "OPTIONS"])
def handle_request():
    return vector_search_proxy(request)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)