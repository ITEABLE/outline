# Outline: makes this terminal mirrorable.
# Every interactive terminal (VS Code, Terminal, iTerm, Outline…) starts inside a hidden tmux session on
# Outline's own socket, so Outline can list it, preview it and open it. Installed by Outline into
# ~/Library/Application Support/Outline/shell/ and sourced from the top of ~/.zshrc.
# Turn it off in Outline's terminal picker, or for one terminal with OUTLINE_NO_MIRROR=1.
# If tmux can't start, nothing happens and this is an ordinary shell.
if [[ -o interactive && -t 0 && -t 1 && -z $TMUX && -z $OUTLINE_NO_MIRROR && -z $INSIDE_EMACS ]] && (( $+commands[tmux] )); then
  case $TERM_PROGRAM in
    vscode) _outline_app=vscode ;;
    Apple_Terminal) _outline_app=terminal ;;
    iTerm.app) _outline_app=iterm ;;
    Outline) _outline_app=outline ;;
    WarpTerminal) _outline_app=warp ;;
    ghostty) _outline_app=ghostty ;;
    *) _outline_app=shell ;;
  esac
  _outline_id=${OUTLINE_MIRROR_ID:-$_outline_app-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 4)}
  # the session ends when its last terminal closes; `exit` inside it closes this terminal as usual
  tmux -L outline -f "${${(%):-%x}:h}/tmux.conf" new-session -s "$_outline_id" -c "$PWD" \
    -e "OUTLINE_SESSION=$_outline_id" -e "TERM_PROGRAM=$TERM_PROGRAM" \; set-option @app "$_outline_app" && exit
  unset _outline_app _outline_id
fi
