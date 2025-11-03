Vector Search Cloud Function (Vertex AI)

Overview
--------
This folder contains a Google Cloud Function implementation (`main.py`) that acts as a proxy to Vertex AI Vector Search (MatchService). The function receives a JSON POST with a `feature_vector` (array of 1408 floats) and returns the nearest neighbors from the deployed index.

Files
-----
- `main.py` - The Cloud Function entrypoint (`http_vector_search`) and helper logic that calls `aiplatform.MatchServiceClient`.
- `requirements.txt` - Python dependencies for the function.

Contract
--------
Request (JSON POST):
{
  "feature_vector": [float, float, ...],   # required, length 1408
  "neighbor_count": 10,                    # optional, default 10
  "normalize": false                       # optional, whether to L2-normalize vector before query
}

Response (200):
{
  "results": [
    {"id": "12345", "distance": 0.123},
    ...
  ]
}

Errors:
- 400: validation errors (missing vector, wrong length, etc.)
- 500: internal server errors

Environment variables
---------------------
The function reads these environment variables (all have defaults matching your setup):
- `API_ENDPOINT` - Public API endpoint for Vertex AI vector domain. Default: `686659988.us-east1.847479956619.vdb.vertexai.goog`
- `INDEX_ENDPOINT_RESOURCE` - Full resource name of index endpoint. Default: `projects/847479956619/locations/us-east1/indexEndpoints/2877628638075813888`
- `DEPLOYED_INDEX_ID` - Deployed index id. Default: `Blusas-Vestidos-Index-Final`
- `DEFAULT_NEIGHBOR_COUNT` - Default number of neighbors to request. Default: `10`

Deployment (gcloud)
-------------------
1. Enable APIs and set project

```powershell
# Set your project
gcloud config set project YOUR_PROJECT_ID
# Enable required APIs
gcloud services enable cloudfunctions.googleapis.com aiplatform.googleapis.com
```

2. Create or choose a service account with minimal permissions

The function needs to call Vertex AI MatchService. Create a service account and grant it the following roles:
- `roles/aiplatform.user` (or a narrower role that allows calling MatchService)
- `roles/cloudfunctions.invoker` (if you want to control invocation via IAM)

```powershell
gcloud iam service-accounts create vector-search-fn --display-name "Vector Search Function"
# Replace PROJECT_ID and SA_EMAIL
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID --member "serviceAccount:vector-search-fn@YOUR_PROJECT_ID.iam.gserviceaccount.com" --role "roles/aiplatform.user"
```

3. Deploy the function

```powershell
gcloud functions deploy vector_search --runtime python310 --trigger-http --entry-point http_vector_search --region us-east1 --timeout=60s --memory=512MB --service-account vector-search-fn@YOUR_PROJECT_ID.iam.gserviceaccount.com --set-env-vars "API_ENDPOINT=686659988.us-east1.847479956619.vdb.vertexai.goog,INDEX_ENDPOINT_RESOURCE=projects/847479956619/locations/us-east1/indexEndpoints/2877628638075813888,DEPLOYED_INDEX_ID=Blusas-Vestidos-Index-Final"
```

Notes:
- Increase `--timeout` and `--memory` if you expect heavy loads or want to process images in the function.
- If you prefer Cloud Run for more flexibility, you can containerize the function using Cloud Build and deploy to Cloud Run.

Testing the function
--------------------
Example curl call (replace URL with deployed function URL):

```powershell
$body = '{"feature_vector": [' + (1..1408 | ForEach-Object { '0.001' }) -join ',' + '], "neighbor_count": 5 }'
curl -X POST "https://REGION-PROJECT.cloudfunctions.net/vector_search" -H "Content-Type: application/json" -d $body
```

Local testing
-------------
You can run the function locally using the Functions Framework:

```powershell
pip install -r requirements.txt
# Run
functions-framework --target http_vector_search --debug
# Then POST to http://127.0.0.1:8080
```

Security & recommendations
--------------------------
- Do not expose direct Vertex AI endpoints to public clients. Keep this function as a proxy so credentials remain server-side.
- Add request authentication to the function (IAM, API keys or signed tokens) if it's not public.
- If clients upload images, prefer uploading to GCS with signed URLs and let a backend job compute embeddings.
- Add monitoring (Cloud Monitoring), structured logs, and set alerts for error rates and latency.

Troubleshooting
---------------
- If you receive permission errors when calling Vertex AI, ensure the service account has the right roles and that the Vertex AI API is enabled.
- If the response is empty, check that the `DEPLOYED_INDEX_ID` and `INDEX_ENDPOINT_RESOURCE` are correct and that the index has datapoints.

Contact
-------
For questions about the function or the integration, add a GitHub issue or contact the developer.
