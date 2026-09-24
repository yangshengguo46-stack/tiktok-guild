#!/usr/bin/env bash

# Load DeerFlow's repository .env without allowing it to replace runtime paths
# explicitly selected by the calling process. This file is sourced by serve.sh.

load_deerflow_env_preserving_runtime_paths() {
    local env_file="$1"
    local had_config_path=0
    local had_extensions_config_path=0
    local had_skills_path=0
    local had_home=0
    local had_social_assets_path=0
    local saved_config_path=""
    local saved_extensions_config_path=""
    local saved_skills_path=""
    local saved_home=""
    local saved_social_assets_path=""
    local had_allexport=0

    if [ "${DEER_FLOW_CONFIG_PATH+x}" = x ]; then
        had_config_path=1
        saved_config_path="$DEER_FLOW_CONFIG_PATH"
    fi
    if [ "${DEER_FLOW_EXTENSIONS_CONFIG_PATH+x}" = x ]; then
        had_extensions_config_path=1
        saved_extensions_config_path="$DEER_FLOW_EXTENSIONS_CONFIG_PATH"
    fi
    if [ "${DEER_FLOW_SKILLS_PATH+x}" = x ]; then
        had_skills_path=1
        saved_skills_path="$DEER_FLOW_SKILLS_PATH"
    fi
    if [ "${DEER_FLOW_HOME+x}" = x ]; then
        had_home=1
        saved_home="$DEER_FLOW_HOME"
    fi
    if [ "${DEER_FLOW_SOCIAL_ASSETS_PATH+x}" = x ]; then
        had_social_assets_path=1
        saved_social_assets_path="$DEER_FLOW_SOCIAL_ASSETS_PATH"
    fi

    case "$-" in
        *a*) had_allexport=1 ;;
    esac
    if [ -f "$env_file" ]; then
        set -a
        # serve.sh supplies the repository .env path.
        # shellcheck disable=SC1090
        source "$env_file"
        if [ "$had_allexport" -eq 0 ]; then
            set +a
        fi
    fi

    if [ "$had_config_path" -eq 1 ]; then
        export DEER_FLOW_CONFIG_PATH="$saved_config_path"
    fi
    if [ "$had_extensions_config_path" -eq 1 ]; then
        export DEER_FLOW_EXTENSIONS_CONFIG_PATH="$saved_extensions_config_path"
    fi
    if [ "$had_skills_path" -eq 1 ]; then
        export DEER_FLOW_SKILLS_PATH="$saved_skills_path"
    fi
    if [ "$had_home" -eq 1 ]; then
        export DEER_FLOW_HOME="$saved_home"
    fi
    if [ "$had_social_assets_path" -eq 1 ]; then
        export DEER_FLOW_SOCIAL_ASSETS_PATH="$saved_social_assets_path"
    fi
}
