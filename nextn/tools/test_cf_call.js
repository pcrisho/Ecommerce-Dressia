const { GoogleAuth } = require('google-auth-library');

async function main(){
  const audience = process.env.VECTOR_SEARCH_CF_AUDIENCE;
  const url = process.env.VECTOR_SEARCH_CF_URL;
  if(!audience || !url){
    console.error('Missing env vars. Please set VECTOR_SEARCH_CF_URL and VECTOR_SEARCH_CF_AUDIENCE');
    process.exit(2);
  }

  try{
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(audience);
    const headers = await client.getRequestHeaders();

    const feature_vector = Array.from({ length: 1408 }, () => Math.random());
    const payload = { feature_vector, neighbor_count: 5 };

    console.log('Calling Cloud Function:', url);
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(payload),
    });

    console.log('Response status:', resp.status);
    const text = await resp.text();
    try{
      const json = JSON.parse(text);
      console.log('Response JSON:', JSON.stringify(json, null, 2));
    }catch(e){
      console.log('Response text:', text);
    }
  }catch(err){
    console.error('Error while calling Cloud Function:', err);
    if(err.message && /Could not load the default credentials|No application default credentials|getIdToken/gi.test(err.message)){
      console.error('\nIt looks like Application Default Credentials are not available. Run:');
      console.error('  gcloud auth application-default login');
    }
    process.exit(1);
  }
}

main();
