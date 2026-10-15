#!/bin/bash
# Double-click on macOS: starts the local preview server and opens the login page.
cd "$(dirname "$0")"
(sleep 1.5 && open "http://localhost:8000") &
python3 dev_server.py --port 8000
