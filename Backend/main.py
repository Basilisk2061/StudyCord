import os
# pyrefly: ignore [missing-import]
import httpx
# pyrefly: ignore [missing-import]
from fastapi import FastAPI, HTTPException
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv

# Load env variables from Backend/.env or current working directory
load_dotenv()

METERED_DOMAIN = os.getenv("METERED_DOMAIN", "studycord.metered.live")
METERED_SECRET_KEY = os.getenv("METERED_SECRET_KEY")

app = FastAPI(title="StudyCord Secure TURN API")

# Enable CORS for the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/turn-credentials")
async def get_turn_credentials():
    if not METERED_SECRET_KEY:
        print("[TURN-API] METERED_SECRET_KEY environment variable is not set.")
        raise HTTPException(
            status_code=500,
            detail="METERED_SECRET_KEY environment variable is not set on the backend."
        )

    post_url = f"https://{METERED_DOMAIN}/api/v1/turn/credential"
    post_params = {"secretKey": METERED_SECRET_KEY}
    post_data = {"label": "studycord-dev", "expiryInSeconds": 3600}

    masked_secret = f"{METERED_SECRET_KEY[:4]}...{METERED_SECRET_KEY[-4:]}" if METERED_SECRET_KEY and len(METERED_SECRET_KEY) > 8 else "***"
    print(f"[TURN-API] Creating TURN credential. URL: {post_url}?secretKey={masked_secret}, Body: {post_data}")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Step 1: Create TURN credential
            post_response = await client.post(post_url, params=post_params, json=post_data)
            post_response.raise_for_status()
            credential_info = post_response.json()
            
            api_key = credential_info.get("apiKey")
            if not api_key:
                print(f"[TURN-API] POST response did not contain 'apiKey'. Response: {credential_info}")
                raise HTTPException(
                    status_code=502,
                    detail="Failed to retrieve apiKey from Metered credential creation."
                )

            # Step 2: Fetch ICE servers using the api key
            get_url = f"https://{METERED_DOMAIN}/api/v1/turn/credentials"
            get_params = {"apiKey": api_key}
            
            masked_api_key = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "***"
            print(f"[TURN-API] Fetching ICE servers. URL: {get_url}?apiKey={masked_api_key}")

            get_response = await client.get(get_url, params=get_params)
            get_response.raise_for_status()
            
            ice_servers = get_response.json()
            return ice_servers
    except httpx.HTTPStatusError as e:
        print(f"[TURN-API] Metered API returned error status {e.response.status_code}: {e.response.text}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch credentials from Metered API: {e.response.text}"
        )
    except Exception as e:
        print(f"[TURN-API] Connection error fetching Metered credentials: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal connection error: {str(e)}"
        )

if __name__ == "__main__":
    import uvicorn
    # Read port from env if needed, default to 8000
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
