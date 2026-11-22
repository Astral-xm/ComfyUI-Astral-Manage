from .nodes import (
  NODE_CLASS_MAPPINGS as LORA_NODE_CLASS_MAPPINGS,
  NODE_DISPLAY_NAME_MAPPINGS as LORA_NODE_DISPLAY_NAME_MAPPINGS,
)
from . import routes as _routes
from .local_llm_service import (
  install_global_unload_hook as _install_local_llm_unload_hook,
)

_install_local_llm_unload_hook()

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
  **LORA_NODE_CLASS_MAPPINGS,
}
NODE_DISPLAY_NAME_MAPPINGS = {
  **LORA_NODE_DISPLAY_NAME_MAPPINGS,
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
