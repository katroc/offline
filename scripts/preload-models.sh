#!/bin/bash

# Ollama Model Preloading Script for Cabin Deployment
# This script downloads and caches the required models for offline operation

set -euo pipefail

# Configuration from .env or defaults
CHAT_MODEL="${LLM_CHAT_MODEL:-llama3.1:8b}"
EMBED_MODEL="${LLM_EMBED_MODEL:-nomic-embed-text}"
OLLAMA_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:11434}"

echo "=== Ollama Model Preloading ==="
echo "Chat Model: $CHAT_MODEL"
echo "Embedding Model: $EMBED_MODEL"
echo "Ollama URL: $OLLAMA_BASE_URL"
echo

# Check if Ollama is running
check_ollama() {
    echo "Checking Ollama connection..."
    if ! curl -s "$OLLAMA_BASE_URL/api/tags" > /dev/null; then
        echo "❌ Error: Ollama is not running at $OLLAMA_BASE_URL"
        echo "Please start Ollama first: ollama serve"
        exit 1
    fi
    echo "✅ Ollama is running"
}

# Pull and cache a model
pull_model() {
    local model="$1"
    echo "📦 Pulling model: $model"
    
    if ollama pull "$model"; then
        echo "✅ Successfully pulled: $model"
    else
        echo "❌ Failed to pull: $model"
        return 1
    fi
    
    # Test the model
    echo "🧪 Testing model: $model"
    if ollama run "$model" "Hello" --verbose 2>/dev/null | grep -q "Hello" || true; then
        echo "✅ Model test passed: $model"
    else
        echo "⚠️  Model test inconclusive: $model (may still work)"
    fi
    echo
}

# Verify model is cached locally
verify_model() {
    local model="$1"
    echo "🔍 Verifying model: $model"
    
    if ollama list | grep -q "$model"; then
        local size=$(ollama list | grep "$model" | awk '{print $2}')
        echo "✅ Model cached locally: $model ($size)"
        return 0
    else
        echo "❌ Model not found: $model"
        return 1
    fi
}

# Main execution
main() {
    check_ollama
    
    echo "=== Pulling Models ==="
    pull_model "$CHAT_MODEL"
    
    # Only pull embedding model if different from chat model
    if [ "$EMBED_MODEL" != "$CHAT_MODEL" ]; then
        pull_model "$EMBED_MODEL"
    else
        echo "📝 Note: Using same model for chat and embeddings: $CHAT_MODEL"
    fi
    
    echo "=== Verification ==="
    verify_model "$CHAT_MODEL"
    if [ "$EMBED_MODEL" != "$CHAT_MODEL" ]; then
        verify_model "$EMBED_MODEL"
    fi
    
    echo
    echo "🎉 Model preloading complete!"
    echo "📊 Disk usage:"
    ollama list
    
    echo
    echo "💡 For Cabin deployment:"
    echo "   1. Export models: ollama export $CHAT_MODEL > $CHAT_MODEL.tar"
    echo "   2. Import on target: ollama import $CHAT_MODEL < $CHAT_MODEL.tar"
}

# Handle script arguments
case "${1:-}" in
    --check)
        check_ollama
        verify_model "$CHAT_MODEL"
        [ "$EMBED_MODEL" != "$CHAT_MODEL" ] && verify_model "$EMBED_MODEL"
        ;;
    --list)
        ollama list
        ;;
    --help|-h)
        echo "Usage: $0 [--check|--list|--help]"
        echo "  --check: Verify models are cached"
        echo "  --list:  List all cached models"
        echo "  --help:  Show this help"
        ;;
    *)
        main
        ;;
esac