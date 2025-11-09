POC: Vertex AI embeddings + Matching Engine

Overview
- This POC adds a fallback endpoint and scripts to produce embeddings for the existing image catalog, upload images to GCS, and run a Vertex-based embedding call.

Prerequisites
- Node.js installed
- Google Cloud project with Vertex AI & Cloud Storage enabled
- A service account JSON with permissions for Storage & Vertex and exported as GOOGLE_APPLICATION_CREDENTIALS
- The bucket used in this repo: gs://project-b38a3360-bucket-entrenamiento (change as needed)

Quick steps (PowerShell)

# install deps
npm install

# upload images to GCS (requires GOOGLE_APPLICATION_CREDENTIALS set)
node .\scripts\gcp_upload_images.js --bucket project-b38a3360-bucket-entrenamiento --prefix ENTRENAMIENTO/

# generate embeddings using Vertex (set VERTEX_MODEL_NAME to full resource name)
$env:VERTEX_MODEL_NAME = 'projects/PROJECT/locations/us-central1/models/MODEL'
node .\scripts\gcp_generate_embeddings_vertex.js --bucket project-b38a3360-bucket-entrenamiento --out data/training_embeddings.json --model $env:VERTEX_MODEL_NAME

# start dev
npm run dev

# call endpoint
POST /api/search/visual-match-vertex
- form-data key 'file' -> the image file

Notes
- The endpoint will try Vertex if VERTEX_MODEL_NAME env var exists. If Vertex fails or is not configured, it will look for data/training_embeddings.json and run a brute-force cosine search.
- The scripts are defensive and will not proceed without credentials.
