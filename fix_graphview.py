import re
with open('frontend/src/components/GraphView.tsx', 'r', encoding='utf-8') as f:
    data = f.read()
# Replace literal backtick-n with actual newline
data = data.replace('`n', '\n')
# Fix double-single-quotes from PowerShell corruption
data = data.replace("''", "'")
with open('frontend/src/components/GraphView.tsx', 'w', encoding='utf-8') as f:
    f.write(data)
print('done')
