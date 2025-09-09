FROM nginx:alpine

# Copy built files
COPY packages/web-ui/dist /usr/share/nginx/html

# Copy nginx configuration
COPY packages/web-ui/nginx.conf /etc/nginx/nginx.conf

# Expose port
EXPOSE 3000

# Start nginx
CMD ["nginx", "-g", "daemon off;"]