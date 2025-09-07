# Cabin 🏠

> **An air-gapped Confluence QA assistant powered by local LLMs**

Cabin is a privacy-first, offline-capable question-answering system that helps teams query their Confluence documentation using local Large Language Models. Perfect for organizations that require air-gapped environments or want to keep their data completely private.

## 🎯 What is Cabin?

Cabin transforms your Confluence documentation into an intelligent, searchable knowledge base that:
- **Runs entirely offline** - No data leaves your network
- **Uses local LLMs** - Compatible with LM Studio, Ollama, and other OpenAI-compatible servers
- **Provides cited answers** - Every response includes source references
- **Works air-gapped** - Perfect for secure environments

## ✨ Key Features

- 🔒 **Privacy-First**: Your data never leaves your environment
- 🚀 **Fast Retrieval**: Smart RAG pipeline with LLM-assisted document analysis
- 📚 **Rich Citations**: Every answer includes clickable source references
- 💬 **Chat Interface**: Intuitive web UI with conversation history
- 📱 **Responsive Design**: Works on desktop and mobile
- 🛠️ **Developer-Friendly**: Full TypeScript, modern stack

## 🏗️ Architecture

Built as a monorepo with clean separation of concerns:
- **MCP Server**: Node.js/Fastify backend with RAG pipeline
- **Web UI**: React/Vite frontend with chat interface
- **Shared Types**: Common interfaces across packages
- **Local Storage**: LanceDB vector store with document indexing

## 📊 Current Status

- ✅ **MCP Server**: Production-ready with health, models, chat, and RAG endpoints
- ✅ **Web UI**: Functional chat interface with history and export
- ✅ **Air-Gapped Operation**: Fully functional without internet connectivity
- ✅ **Security**: Linting and security scanning configured

## 📁 Project Structure

```
cabin/
├── packages/
│   ├── mcp-server/     # Fastify backend with RAG pipeline
│   ├── web-ui/         # React frontend with chat interface  
│   └── shared/         # Common types and interfaces
├── tools/              # Data ingestion and utility scripts
├── scripts/            # Deployment and setup scripts
└── infra/              # Infrastructure configuration
```

## 🚀 Quick Start

### Prerequisites
- **Node.js 20+** and **pnpm 9+**
- **Local LLM** (LM Studio, Ollama, or OpenAI-compatible server)
- **Optional**: Confluence access for live data sync

### 1️⃣ Setup Environment
```bash
# Clone and install dependencies
git clone <your-repo>
cd cabin
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your LLM and Confluence settings
```

### 2️⃣ Start the Application
```bash
# Build all packages
pnpm build

# Start in development mode (recommended)
pnpm dev

# OR start production mode
pnpm -F @app/mcp-server start  # Backend on :8787
pnpm -F @app/web-ui preview    # Frontend on :4173
```

### 3️⃣ Access the Interface
- **Web UI**: http://localhost:4173 (production) or http://localhost:5173 (dev)
- **API Health**: http://localhost:8787/health
- **Available Models**: http://localhost:8787/models

## 💡 Usage Examples

### Basic Question Answering
```
Q: "How do I set up our CI/CD pipeline?"
A: Based on your Confluence documentation, here's how to set up the CI/CD pipeline... [with citations]
```

### Troubleshooting Queries  
```
Q: "Why is the authentication service failing?"
A: The authentication service can fail for several reasons documented in your troubleshooting guide... [with citations]
```

### Configuration Help
```
Q: "What are the required environment variables for production?"
A: According to the deployment documentation, the required environment variables are... [with citations]
```

## 🔧 API Reference

### Core Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check and status |
| `GET` | `/models` | List available LLM models |
| `POST` | `/chat/completions` | OpenAI-compatible chat completions |
| `POST` | `/rag/query` | Synchronous RAG query with citations |
| `POST` | `/rag/stream` | Server-Sent Events RAG query |

### Example RAG Query
```bash
curl -X POST http://localhost:8787/rag/query \
  -H "Content-Type: application/json" \
  -d '{
    "question": "How do I deploy the application?",
    "space": "DEV",
    "topK": 5
  }'
```

### Response Format
```json
{
  "answer": "To deploy the application, follow these steps...",
  "citations": [
    {
      "pageId": "12345",
      "title": "Deployment Guide",
      "url": "https://confluence.example.com/pages/12345",
      "snippet": "Deployment process overview..."
    }
  ]
}
```

## ⚙️ Configuration

### Environment Variables
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_PORT` | Server port | `8787` | No |
| `MCP_HOST` | Server host | `127.0.0.1` | No |
| `LLM_BASE_URL` | OpenAI-compatible LLM endpoint | - | Yes* |
| `LLM_CHAT_MODEL` | Chat model identifier | - | Yes* |
| `LLM_EMBED_MODEL` | Embedding model identifier | - | No |
| `CONFLUENCE_BASE_URL` | Confluence server URL | - | No |
| `CONFLUENCE_USERNAME` | Confluence username | - | No |
| `CONFLUENCE_API_TOKEN` | Confluence API token | - | No |
| `LANCEDB_PATH` | Vector database path | `./data/lancedb` | No |
| `USE_REAL_VECTORDB` | Enable LanceDB | `true` | No |
| `USE_SMART_PIPELINE` | Enable smart RAG pipeline | `true` | No |
| `RELEVANCE_THRESHOLD` | Minimum relevance score for sources (0-1) | `0.2` | No |

*Required for full functionality. Without LLM config, returns mock responses.

### Example .env
```bash
# LLM Configuration (LM Studio)
LLM_BASE_URL=http://127.0.0.1:1234
LLM_CHAT_MODEL=microsoft/DialoGPT-medium

# Confluence (Optional)
CONFLUENCE_BASE_URL=https://your-company.atlassian.net
CONFLUENCE_USERNAME=your-email@company.com
CONFLUENCE_API_TOKEN=your-api-token

# Server Configuration
MCP_PORT=8787
MCP_HOST=127.0.0.1

# RAG Configuration
RELEVANCE_THRESHOLD=0.2    # Higher values = more selective sources
```

## 🛠️ Development Workflow

### Available Scripts
```bash
# Development
pnpm dev              # Start all services in development mode
pnpm typecheck        # Run TypeScript checks across all packages
pnpm lint             # Run ESLint for code quality
pnpm lint:fix         # Auto-fix linting issues

# Security & Quality  
pnpm security:check   # Run security audits
pnpm check            # Run all checks (typecheck + lint + security)

# Building
pnpm build            # Build all packages
pnpm -F @app/mcp-server build  # Build specific package
```

### Air-Gapped Operations
```bash
# Preload models for offline use
scripts/preload-models.sh

# Import Confluence data without network access
node tools/ingest-confluence.mjs --space DEV --maxPages 100 --server http://127.0.0.1:8787
```

## 🆘 Troubleshooting

### Common Issues

#### "No models available"
- Ensure your LLM server (LM Studio/Ollama) is running
- Check `LLM_BASE_URL` points to the correct endpoint
- Verify the model is loaded in your LLM server

#### "Connection refused" errors
- Check if the MCP server is running on the correct port
- Verify firewall settings aren't blocking the connection
- Ensure `MCP_PORT` and `MCP_HOST` are configured correctly

#### "No search results" or empty responses
- Verify Confluence credentials are correct
- Check if documents have been ingested: http://localhost:8787/health
- Try using the ingestion tool to add documents manually

#### Vector database issues  
- Delete `./data/lancedb` to reset the vector store
- Set `USE_REAL_VECTORDB=false` to use mock storage
- Check disk permissions for the data directory

### Getting Help

1. **Check logs**: Server logs contain detailed error information
2. **Health endpoint**: Visit `/health` to see system status
3. **Mock mode**: Disable Confluence and LLM for basic UI testing
4. **Issues**: Report bugs with logs and configuration details

## 👥 Contributing

### Development Setup
1. Fork and clone the repository  
2. Install dependencies: `pnpm install`
3. Copy environment: `cp .env.example .env`
4. Start development: `pnpm dev`

### Code Quality
- **Linting**: ESLint with TypeScript and security rules
- **Security**: Automated vulnerability scanning
- **Testing**: Run `pnpm check` before submitting PRs
- **Documentation**: Update README for significant changes

### Architecture Notes
- **Type Safety**: Full TypeScript across all packages
- **Security**: No data transmission outside your network
- **Performance**: Streaming responses and vector similarity search
- **Maintainability**: Clean separation between UI, API, and data layers
