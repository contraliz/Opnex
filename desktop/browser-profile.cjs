const path=require('node:path');
function browserProfilePath({platform,localAppData,userData,isolated}){
  if(isolated&&userData)return path.join(path.resolve(userData),'browser-profile');
  if(platform==='win32'&&localAppData)return path.join(path.resolve(localAppData),'Pseudoharness','browser-profile');
  return path.join(path.resolve(userData),'browser-profile');
}
module.exports={browserProfilePath};
