#!/usr/bin/env python3
"""
SIS Grade Import Script
Reads a JSON file and sends it to Trilium SIS Grade Import Handler
"""

import json
import requests
import sys
from pathlib import Path

# ===== CONFIGURATION =====
# Change these to match your setup
TRILIUM_URL = "http://192.168.0.71:8081"  # Your Trilium server URL (port 8081!)
SECRET_PASSWORD = "your_password_here"  # Must match the password in the handler
JSON_FILE_PATH = "/home/ahepworth/facts-stats/grades_data.json"  # Path to your JSON file
# =========================

def import_sis_grades():
    """Import SIS grade data from JSON file to Trilium"""
    
    # Read the JSON file
    try:
        print(f"📂 Reading JSON file: {JSON_FILE_PATH}")
        with open(JSON_FILE_PATH, 'r') as f:
            grade_data = json.load(f)
        print("✅ JSON file loaded successfully")
    except FileNotFoundError:
        print(f"❌ Error: File not found: {JSON_FILE_PATH}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"❌ Error: Invalid JSON format: {e}")
        sys.exit(1)
    
    # Validate data structure
    if "classes" not in grade_data:
        print("❌ Error: JSON missing 'classes' key")
        sys.exit(1)
    
    class_count = len(grade_data["classes"])
    print(f"📊 Found {class_count} classes in data")
    
    # Prepare the request
    endpoint = f"{TRILIUM_URL}/custom/sis-grade-import"
    payload = {
        "secret": SECRET_PASSWORD,
        "data": grade_data
    }
    
    headers = {
        "Content-Type": "application/json",
        "X-Bridge-Secret": SECRET_PASSWORD  # Header-based auth (matches Classroom Sync pattern)
    }
    
    # Send to Trilium
    try:
        print(f"🚀 Sending to Trilium: {endpoint}")
        response = requests.post(
            endpoint,
            json=payload,
            headers=headers,
            timeout=120  # Increased timeout for large datasets
        )
        
        # Check response
        if response.status_code == 200:
            result = response.json()
            print("✅ Import successful!")
            print(f"   Timestamp: {result['timestamp']}")
            print(f"   Classes imported: {result['classCount']}")
        elif response.status_code == 401:
            print("❌ Error: Unauthorized - Check your SECRET_PASSWORD")
            sys.exit(1)
        elif response.status_code == 400:
            print("❌ Error: Invalid data format")
            print(f"   Details: {response.json()}")
            sys.exit(1)
        elif response.status_code == 405:
            print("❌ Error: Method not allowed - Check the endpoint")
            sys.exit(1)
        else:
            print(f"❌ Error: HTTP {response.status_code}")
            print(f"   Details: {response.text}")
            sys.exit(1)
            
    except requests.exceptions.ConnectionError:
        print(f"❌ Error: Cannot connect to Trilium at {TRILIUM_URL}")
        print("   Make sure Trilium is running and the URL is correct")
        sys.exit(1)
    except requests.exceptions.Timeout:
        print("❌ Error: Request timed out")
        print("   Try increasing the timeout or check if the data is too large")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    import_sis_grades()
