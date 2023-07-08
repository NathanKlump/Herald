const PersonalMessage = (user, channel) => {
    
    if (user.includes('Jerkyturd')) {
      return `${user} has joined ${channel} and is opening CSGO cases.`;
    } else if (user.includes('icewallowpis')) {
      return `${user} is in ${channel} being racist and homophobic.`;
    } else if (user.includes('nathanielklump')) {
      return `${user} has joined ${channel} and will probably be leaving in 30 min.`;
    } else if (user.includes('acidpuddle')) {
        return `${user} has joined ${channel} and will be lowering everyone's mental.`;
    } else {
      return `${user} joined voice channel ${channel}`;
    }
  };
  
  module.exports = { PersonalMessage };
  