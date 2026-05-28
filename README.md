# ServiceNow ERD Visualizer

A JSON-based Entity Relationship Diagram (ERD) visualizer for ServiceNow instances. Maps your entire ServiceNow schema and visualizes table relationships interactively.

## Features

- **Schema Mapping**: Automatically fetches all tables and fields from your ServiceNow instance
- **Interactive Visualization**: Uses Vis.js for interactive ERD diagrams with physics simulation
- **Relationship Detection**: Automatically identifies foreign key relationships between tables
- **Entity Browser**: Sidebar listing all tables with field counts
- **Click-to-Focus**: Click any table in the sidebar to focus on it in the diagram

## Setup

### Prerequisites
- Node.js 16+
- ServiceNow instance with API access
- ServiceNow user credentials with table read permissions

### Installation

```bash
npm install
```

### Running Locally

```bash
npm run dev
```

Visit `http://localhost:3000` in your browser.

## Usage

1. Enter your ServiceNow instance name (e.g., `dev12345`)
2. Enter your ServiceNow username
3. Enter your ServiceNow password
4. Click "Generate ERD"
5. Interact with the diagram:
   - Drag nodes to rearrange
   - Scroll to zoom
   - Click tables in the sidebar to focus on them
   - Hover over relationships to see field names

## API Endpoints

### POST `/api/erd/generate`
Generates ERD from ServiceNow instance.

**Request:**
```json
{
  "instance": "dev12345",
  "username": "admin",
  "password": "password"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Generated ERD for 50 tables",
  "erd": {
    "entities": {
      "incident": {
        "id": "sys_id",
        "name": "incident",
        "label": "Incident",
        "fields": [
          {
            "name": "number",
            "label": "Number",
            "type": "string",
            "reference": null,
            "mandatory": true
          }
        ]
      }
    },
    "relationships": [
      {
        "from": "incident",
        "to": "cmdb_ci",
        "field": "cmdb_ci",
        "type": "foreign_key"
      }
    ]
  }
}
```

### GET `/api/erd`
Returns the cached ERD from the last generation.

## Deployment on Railway

1. Push to GitHub
2. Connect your repo to Railway
3. Set environment variables if needed
4. Deploy!

## Architecture

- **Backend**: Express.js server with ServiceNow API integration
- **Frontend**: Interactive Vis.js visualization with responsive sidebar
- **Schema Fetching**: Uses ServiceNow REST API to fetch tables and fields
- **Relationship Detection**: Analyzes reference fields to build relationship graph

## Limitations

- Currently limited to first 50 tables for performance
- Requires valid ServiceNow credentials
- ServiceNow instance must have API access enabled

## Future Enhancements

- [ ] Support for all tables (pagination)
- [ ] Export ERD as image/PDF
- [ ] Custom filtering and search
- [ ] Relationship type detection (1:1, 1:N, M:N)
- [ ] Field-level details panel
- [ ] Dark mode

