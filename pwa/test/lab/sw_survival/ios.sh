D="${SIM_UDID:?set SIM_UDID to a booted simulator}"
i=0
for m in down 404 parking hostile csd-storage csd-404; do
  i=$((i+1)); port=$((8900+i)); b=http://localhost:$port
  curl -s "$b/__mode?m=normal" >/dev/null
  xcrun simctl openurl $D "$b/?step=install"; sleep 8
  curl -s "$b/__mode?m=$m" >/dev/null
  xcrun simctl openurl $D "$b/?step=update"; sleep 8
  xcrun simctl openurl $D "$b/?step=reopen"; sleep 6
  echo "== $m"; curl -s "$b/__reports"; echo
done
