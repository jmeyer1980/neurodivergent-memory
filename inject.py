with open('test-memory-graph.ts', 'r') as f:
    lines = f.readlines()

# Find the line with "log(`← Response id=" and insert completion check after the closing brace
new_lines = []
i = 0
while i < len(lines):
    new_lines.append(lines[i])
    
    # Check if this line contains the response log statement
    if 'Response id=' in lines[i] and '← Response id=' in lines[i]:
        # Next line(s) should be blank or closing brace
        i += 1
        if i < len(lines) and lines[i].strip() == '':
            new_lines.append(lines[i])
            i += 1
        
        # Now add the closing brace if we see it
        if i < len(lines) and '}' in lines[i]:
            new_lines.append(lines[i])  # This should be "    }"
            
            # Insert completion check  
            new_lines.append('      \n')
            new_lines.append('      if (checkCompletion()) {\n')
            new_lines.append('        log(`\\nAll ${totalRequestsExpected} responses received!`);\n')
            new_lines.append('        writeResultsAndExit();\n')
            new_lines.append('      } else {\n')
            new_lines.append('        resetCompletionTimeout();\n')
            new_lines.append('      }\n')
            continue
    
    i += 1

with open('test-memory-graph.ts', 'w') as f:
    f.writelines(new_lines)

print('✓ Completion check injected')
